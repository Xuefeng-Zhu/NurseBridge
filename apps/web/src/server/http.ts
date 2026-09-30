import { ZodError } from 'zod';
export class HttpError extends Error {
    readonly code?: string;
    constructor(public status: number, message: string, code?: unknown) {
        super(message);
        if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)) this.code = code;
    }
}
export function json(data: unknown, status = 200, headers: HeadersInit = {}) { return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } }); }
export async function body(request: Request): Promise<Record<string, unknown>> { if (Number(request.headers.get('content-length') ?? 0) > 32768)
    throw new HttpError(413, 'Request too large'); const text = await request.text(); if (text.length > 32768)
    throw new HttpError(413, 'Request too large'); try {
    const value = JSON.parse(text || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object')
        throw new Error();
    return value;
}
catch {
    throw new HttpError(400, 'Invalid JSON body');
} }
export function endpoint(fn: (request: Request, context: any) => Promise<Response>) { return async (request: Request, context: any) => { try {
    return await fn(request, context);
}
catch (error) {
    if (error instanceof HttpError)
        return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    if (error instanceof ZodError)
        return json({ error: 'Invalid request fields' }, 400);
    return json({ error: 'The operation could not be completed. Please retry.' }, 503);
} }; }
export function unwrap<T extends {
    ok: boolean;
}>(result: T): T { if (!result.ok) {
    const failure = result as unknown as {
        status?: number;
        error?: string;
        code?: unknown;
    };
    throw new HttpError(failure.status ?? 503, failure.error ?? 'Session unavailable', failure.code);
} return result; }
