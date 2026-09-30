import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { CallCommand, CallSnapshot, Mode, RpcResult, IntakeTemplate } from '@nursebridge/contracts';
export interface CallRpc {
    initialize(input: {
        callId: string;
        workspaceId: string;
        callerParticipantId: string;
        template: IntakeTemplate;
        mode: Mode;
    }): Promise<RpcResult<{
        snapshot: CallSnapshot;
    }>>;
    snapshot(workspaceId: string): Promise<RpcResult<{
        snapshot: CallSnapshot;
    }>>;
    command(input: CallCommand): Promise<RpcResult<{
        snapshot: CallSnapshot;
    }>>;
    issueTicket(input: {
        workspaceId: string;
        participantId: string;
        role: 'caller' | 'nurse' | 'observer';
    }): Promise<RpcResult<{
        ticket: string;
        expiresAt: number;
        websocketPath: string;
    }>>;

}
export interface AppEnv {
    MAX_ACTIVE_CALLS_PER_WORKSPACE?: string;
    MAX_LIVE_CONCURRENCY?: string;
    DAILY_AUDIO_MINUTES?: string;
    DB: D1Database;
    CALL_SESSIONS: DurableObjectNamespace;
    REALTIME: Fetcher;
    APP_ORIGIN: string;
    REALTIME_URL: string;
    PROVIDER_MODE: Mode;
    ALLOW_TEST_DIAGNOSTICS?: string;
    ALLOW_LOCAL_SANDBOX_ENROLLMENT?: string;
    PUBLIC_WORKSPACE_ACCESS?: string;
    TURNSTILE_SECRET_KEY?: string;
    TURNSTILE_SITE_KEY?: string;
    ACCESS_ISSUER?: string;
    ACCESS_AUDIENCE?: string;
}
export function env(): AppEnv { return getCloudflareContext().env as unknown as AppEnv; }
export function callObject(bindings: AppEnv, id: string): CallRpc { return bindings.CALL_SESSIONS.get(bindings.CALL_SESSIONS.idFromName(id)) as unknown as CallRpc; }
