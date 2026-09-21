import { migrateState, type CallState } from '../state';

export type OutboxEntry = { id: string; revision: number; body: string; attempts: number };
export class SessionStore {
  constructor(readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS final_turns (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fact_revisions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, participant_id TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_connections (attempt_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_cleanup (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'retained', attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tool_receipts (id TEXT PRIMARY KEY, request TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS export_reservations (id TEXT PRIMARY KEY, object_key TEXT NOT NULL, status TEXT NOT NULL);
    `);
    if (!storage.sql.exec<{name:string}>('PRAGMA table_info(commands)').toArray().some(column=>column.name==='request_hash')) storage.sql.exec("ALTER TABLE commands ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''");
  }
  load(): CallState | undefined {
    const row = this.storage.sql.exec<{body:string}>('SELECT body FROM active_state WHERE id=1').toArray()[0];
    if (!row) return undefined;
    const raw = JSON.parse(row.body) as CallState;
    const state = migrateState(raw);
    if (raw.version !== 2) this.storage.transactionSync(() => this.commit(state, 'snapshot-upgraded', 'Durable state upgraded; prior consent does not authorize recording.'));
    return state;
  }
  save(state: CallState) { this.storage.sql.exec('INSERT INTO active_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify(state)); }
  commit(state: CallState, type: string, message: string, now = Date.now()) {
    state.revision++;
    const event = { id: crypto.randomUUID(), type, message, at: now, revision: state.revision };
    state.timeline.push(event);
    if (state.timeline.length > 500) state.timeline = state.timeline.slice(-500);
    this.save(state);
    for (const turn of state.turns) this.storage.sql.exec('INSERT OR IGNORE INTO final_turns(id,body) VALUES(?,?)', turn.id, JSON.stringify(turn));
    for (const revision of state.factRevisions) this.storage.sql.exec('INSERT OR IGNORE INTO fact_revisions(id,body) VALUES(?,?)', revision.id, JSON.stringify(revision));
    this.storage.sql.exec('INSERT INTO outbox(id,revision,body) VALUES(?,?,?)', event.id, state.revision, JSON.stringify(state));
  }
  pending(): OutboxEntry[] { return this.storage.sql.exec<OutboxEntry>('SELECT id,revision,body,attempts FROM outbox ORDER BY revision ASC LIMIT 10').toArray(); }
  clearContent() {
    this.storage.sql.exec('DELETE FROM tool_receipts; DELETE FROM final_turns; DELETE FROM fact_revisions; DELETE FROM commands; DELETE FROM tickets; DELETE FROM outbox;');
  }
}
