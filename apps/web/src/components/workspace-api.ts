export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type RequestDependencies = {
  fetcher?: typeof fetch;
  maxReadRetries?: number;
  retryDelayMs?: number;
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Retry only idempotent reads that fail with a transient service response. */
export async function requestJson<T>(path: string, options: RequestInit = {}, dependencies: RequestDependencies = {}): Promise<T> {
  const fetcher = dependencies.fetcher ?? fetch;
  const method = (options.method ?? "GET").toUpperCase();
  const maxReadRetries = method === "GET" ? dependencies.maxReadRetries ?? 2 : 0;
  const retryDelayMs = dependencies.retryDelayMs ?? 75;

  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers }, cache: "no-store" });
    const result = await response.json().catch(() => ({})) as { error?: string | { message?: string }; message?: string };
    if (response.ok) return result as T;
    if (response.status === 503 && attempt < maxReadRetries) {
      await wait(retryDelayMs * 2 ** attempt);
      continue;
    }
    throw new ApiError(response.status, typeof result.error === "string" ? result.error : result.error?.message || result.message || `Request failed (${response.status}).`);
  }
}
