import type { CallSession } from './CallSession';

export interface Env {
  CALL_SESSIONS: DurableObjectNamespace<CallSession>;
  DB: D1Database;
  EXPORTS?: R2Bucket;
  ASSEMBLYAI_API_KEY?: string;
  NEBIUS_API_KEY?: string;
  /** Selects managed voice plus Gateway extraction, or the existing Nebius integration. */
  LLM_PROVIDER?: 'nebius' | 'assemblyai';
  PROVIDER_MODE: 'mock' | 'live';
  ALLOWED_ORIGINS: string;
  MAX_CALL_SECONDS?: string;
  RETENTION_SECONDS?: string;
  EXTRACTION_MODEL?: string;
  VOICE_AGENT_ID?: string;
  VOICE_AGENT_VERSION?: string;
  VOICE_AGENT_COMPATIBILITY_VERIFIED?: string;
  FICTIONAL_LIVE_TEST?: string;
  /** Explicit browser-only live activation for one HTTPS origin; not a retention certification. */
  BROWSER_LIVE_INTAKE_ORIGIN?: string;
  PHONE_INBOUND_ENABLED?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Optional trusted HTTP service used by isolated integration tests. */
  TWILIO_HTTP?: Fetcher;
  TWILIO_PUBLIC_ORIGIN?: string;
  /** Operator-owned E.164 destination -> workspace ID mapping. */
  TWILIO_INBOUND_ROUTES?: string;
  PHONE_MAX_CONCURRENT?: string;
  PHONE_DAILY_MINUTES?: string;
  MAX_ACTIVE_CALLS_PER_WORKSPACE?: string;
  MAX_LIVE_CONCURRENCY?: string;
  DAILY_AUDIO_MINUTES?: string;
}
