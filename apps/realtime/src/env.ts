import type { CallSession } from './CallSession';

export interface Env {
  CALL_SESSIONS: DurableObjectNamespace<CallSession>;
  DB: D1Database;
  EXPORTS?: R2Bucket;
  ASSEMBLYAI_API_KEY?: string;
  NEBIUS_API_KEY?: string;
  PROVIDER_MODE: 'mock' | 'live';
  ALLOWED_ORIGINS: string;
  MAX_CALL_SECONDS?: string;
  RETENTION_SECONDS?: string;
  EXTRACTION_MODEL?: string;
  VOICE_AGENT_ID?: string;
  VOICE_AGENT_VERSION?: string;
  VOICE_AGENT_COMPATIBILITY_VERIFIED?: string;
}
