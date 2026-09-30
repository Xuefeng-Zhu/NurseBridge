type PollingOptions<T> = {
  intervalMs: number;
  read: (signal: AbortSignal) => Promise<T>;
  onSuccess: (result: T) => void;
  onError: (reason: unknown) => void;
  onPending?: (pending: boolean) => void;
};

/** One read at a time; disposal fences even responses that ignore cancellation. */
export function startPolling<T>({ intervalMs, read, onSuccess, onError, onPending }: PollingOptions<T>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    const request = new AbortController();
    controller = request;
    onPending?.(true);
    pending = Promise.resolve().then(async () => {
      if (stopped) return;
      try {
        const result = await read(request.signal);
        if (!stopped && !request.signal.aborted) onSuccess(result);
      } catch (reason) {
        if (!stopped && !request.signal.aborted) onError(reason);
      } finally {
        pending = undefined;
        if (!stopped) {
          onPending?.(false);
          timer = setTimeout(() => { void refresh(); }, intervalMs);
        }
      }
    });
    return pending;
  };

  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
