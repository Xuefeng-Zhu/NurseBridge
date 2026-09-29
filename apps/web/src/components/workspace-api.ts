export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type RequestDependencies = {
  fetcher?: typeof fetch;
  maxReadRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Retry only idempotent reads that fail with a transient service response. */
export async function requestJson<T>(path: string, options: RequestInit = {}, dependencies: RequestDependencies = {}): Promise<T> {
  const fetcher = dependencies.fetcher ?? fetch;
  const method = (options.method ?? "GET").toUpperCase();
  const maxReadRetries = method === "GET" ? dependencies.maxReadRetries ?? 2 : 0;
  const retryDelayMs = dependencies.retryDelayMs ?? 75;
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  // Bound the entire request, including reading the body and retry delays.
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, dependencies.timeoutMs ?? 15_000);
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  try {
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      const response = await fetcher(path, { ...options, signal: controller.signal, headers, cache: "no-store" });
      const body: unknown = await response.json().catch(() => undefined);
      controller.signal.throwIfAborted();
      const result = body && typeof body === "object" ? body as { error?: string | { message?: string }; message?: string } : undefined;
      if (response.ok) {
        if (!result) throw new ApiError(502, "The service returned an unreadable response. Please try again.");
        return body as T;
      }
      if (response.status === 503 && attempt < maxReadRetries) {
        await wait(retryDelayMs * 2 ** attempt, controller.signal);
        continue;
      }
      const message = typeof result?.error === "string" ? result.error : result?.error?.message || result?.message;
      throw new ApiError(response.status, typeof message === "string" ? message : `Request failed (${response.status}).`);
    }
  } catch (reason) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timedOut) throw new ApiError(408, method === "GET" ? "The request timed out. Please try again." : "The request timed out. Check the latest state before trying again; the action may have completed.");
    if (reason instanceof TypeError) throw new ApiError(0, "Unable to reach NurseBridge. Check your connection and try again.");
    throw reason;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
