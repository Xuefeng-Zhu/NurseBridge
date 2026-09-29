import { afterEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "../../apps/web/src/components/serialized-polling";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("serialized nurse workspace polling", () => {
  it("does not overlap slow reads, including manual refreshes, and waits after settlement", async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("fresh");
    const onSuccess = vi.fn();
    const poll = startPolling({ intervalMs: 2000, read, onSuccess, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    const refresh = poll.refresh();
    expect(poll.refresh()).toBe(refresh);
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve("initial");
    await refresh;
    expect(onSuccess).toHaveBeenCalledWith("initial");
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenLastCalledWith("fresh");
    poll.stop();
  });

  it.each(["success", "failure"] as const)("aborts and ignores late %s after a selection is superseded", async (outcome) => {
    vi.useFakeTimers();
    const held = deferred<string>();
    let signal!: AbortSignal;
    const read = vi.fn((current: AbortSignal) => { signal = current; return held.promise; });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onPending = vi.fn();
    const poll = startPolling({ intervalMs: 2500, read, onSuccess, onError, onPending });
    const pending = poll.refresh();
    await Promise.resolve();
    poll.stop();
    expect(signal.aborted).toBe(true);
    if (outcome === "success") held.resolve("old case");
    else held.reject(new Error("old error"));
    await pending;
    await vi.advanceTimersByTimeAsync(10_000);
    await poll.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onPending.mock.calls).toEqual([[true]]);
  });

  it("lets a manual retry bypass the delay and resumes polling after an error", async () => {
    vi.useFakeTimers();
    const reason = new Error("queue unavailable");
    const read = vi.fn().mockRejectedValueOnce(reason).mockResolvedValue("recovered");
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const poll = startPolling({ intervalMs: 2000, read, onSuccess, onError });
    await poll.refresh();
    expect(onError).toHaveBeenCalledWith(reason);
    await poll.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith("recovered");
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(3);
    poll.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("recovers when the read throws before returning a promise", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockImplementationOnce(() => { throw new Error("Immediate failure"); }).mockResolvedValue("recovered");
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const poll = startPolling({ intervalMs: 2000, read, onSuccess, onError });
    await poll.refresh();
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSuccess).toHaveBeenCalledWith("recovered");
    poll.stop();
  });
});
