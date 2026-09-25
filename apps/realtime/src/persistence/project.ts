import type { CallSnapshot } from '@nursebridge/contracts';

const contentTables = ['transcript_segments','intake_facts','fact_revisions','nurse_assignments','escalation_events','audit_events','calls','exports'] as const;
export async function projectSnapshot(db: D1Database, snapshot: CallSnapshot): Promise<void> {
  const { id, workspaceId, revision } = snapshot;
  if (snapshot.deleted) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO deletion_tombstones(call_id,workspace_id,deleted_at) VALUES(?,?,?)').bind(id, workspaceId, Date.now()),
      ...contentTables.map(table => db.prepare(`DELETE FROM ${table} WHERE ${table === 'calls' ? 'id' : 'call_id'}=? AND workspace_id=?`).bind(id, workspaceId)),
      ...(snapshot.channel === 'phone' ? [db.prepare("UPDATE inbound_calls SET template_json=NULL,consent_decision=NULL,status='deleted',terminal_at=COALESCE(terminal_at,?) WHERE call_id=? AND workspace_id=?").bind(Date.now(), id, workspaceId)] : []),
      db.prepare('INSERT INTO projection_checkpoints(call_id,workspace_id,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET revision=MAX(revision,excluded.revision),updated_at=excluded.updated_at').bind(id, workspaceId, revision, Date.now()),
    ]);
    return;
  }
  const checkpoint=await db.prepare('SELECT revision FROM projection_checkpoints WHERE call_id=? AND workspace_id=?').bind(id,workspaceId).first<number>('revision')??0;
  if(checkpoint>=revision)return;
  if(checkpoint!==revision-1)throw new Error('Projection predecessor missing; retry ordered outbox.');
  // Every content write has the same monotonic checkpoint and tombstone fence.
  // D1 batch is transactional. A late pre-delete event can never recreate content.
  const fence = 'NOT EXISTS(SELECT 1 FROM deletion_tombstones WHERE call_id=?) AND COALESCE((SELECT revision FROM projection_checkpoints WHERE call_id=?),0) = ? - 1';
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO calls(id,workspace_id,caller_participant_id,created_at,expires_at,queue_state,intake_state,conversation_owner,revision,snapshot_json,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(id) DO UPDATE SET queue_state=excluded.queue_state,intake_state=excluded.intake_state,conversation_owner=excluded.conversation_owner,revision=excluded.revision,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at WHERE excluded.revision>calls.revision`).bind(id,workspaceId,snapshot.callerParticipantId,snapshot.createdAt,snapshot.expiresAt,snapshot.queueState,snapshot.intakeState,snapshot.conversationOwner,revision,JSON.stringify(snapshot),Date.now(),id,id,revision)];
  for (const [table, values] of [ ['transcript_segments',snapshot.turns], ['fact_revisions',snapshot.factRevisions], ['escalation_events',snapshot.escalations] ] as const) {
    for (const item of values) statements.push(db.prepare(`INSERT INTO ${table}(id,call_id,workspace_id,body_json) SELECT ?,?,?,? WHERE ${fence} ON CONFLICT(call_id,id) DO UPDATE SET body_json=excluded.body_json`).bind(item.id,id,workspaceId,JSON.stringify(item),id,id,revision));
  }
  for (const fact of snapshot.facts) statements.push(db.prepare(`INSERT INTO intake_facts(field,call_id,workspace_id,revision,body_json) SELECT ?,?,?,?,? WHERE ${fence} ON CONFLICT(call_id,field) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json WHERE excluded.revision>=intake_facts.revision`).bind(fact.field,id,workspaceId,fact.revision,JSON.stringify(fact),id,id,revision));
  for (const event of snapshot.timeline) statements.push(db.prepare(`INSERT OR IGNORE INTO audit_events(id,call_id,workspace_id,revision,body_json) SELECT ?,?,?,?,? WHERE ${fence}`).bind(event.id,id,workspaceId,event.revision,JSON.stringify(event),id,id,revision));
  if (snapshot.claim) statements.push(db.prepare(`INSERT INTO nurse_assignments(id,call_id,workspace_id,body_json) SELECT ?,?,?,? WHERE ${fence} ON CONFLICT(call_id,id) DO UPDATE SET body_json=excluded.body_json`).bind(snapshot.claim.participantId,id,workspaceId,JSON.stringify(snapshot.claim),id,id,revision));
  statements.push(db.prepare(`INSERT INTO projection_checkpoints(call_id,workspace_id,revision,updated_at) SELECT ?,?,?,? WHERE ${fence} ON CONFLICT(call_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at WHERE projection_checkpoints.revision=excluded.revision-1`).bind(id,workspaceId,revision,Date.now(),id,id,revision));
  await db.batch(statements);
  const applied=await db.prepare('SELECT revision FROM projection_checkpoints WHERE call_id=? AND workspace_id=?').bind(id,workspaceId).first<number>('revision')??0;
  const deleted=await db.prepare('SELECT call_id FROM deletion_tombstones WHERE call_id=? AND workspace_id=?').bind(id,workspaceId).first();
  if(applied<revision&&!deleted)throw new Error('Projection not committed; retry ordered outbox.');
}
