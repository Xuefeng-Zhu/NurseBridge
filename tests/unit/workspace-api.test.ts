import { describe, expect, it, vi } from "vitest";
import { ApiError, requestJson } from "../../apps/web/src/components/workspace-api";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("workspace API reads", () => {
  it("retains a server revision-conflict code without retrying its rejected write", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(409, { error: "The call changed.", code: "revision_conflict" }));
    await expect(requestJson("/api/calls/example/claim", { method: "POST" }, { fetcher })).rejects.toMatchObject({ status: 409, code: "revision_conflict", message: "The call changed." });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retries bounded transient GET failures", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(503, { error: "warming" }))
      .mockResolvedValueOnce(response(503, { error: "still warming" }))
      .mockResolvedValueOnce(response(200, { session: { role: "admin" } }));

    await expect(requestJson("/api/demo/session", {}, { fetcher, retryDelayMs: 0 })).resolves.toEqual({ session: { role: "admin" } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops after the bounded GET retry budget is exhausted", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(503, { error: "still unavailable" }));
    await expect(requestJson("/api/demo/session", {}, { fetcher, retryDelayMs: 0 })).rejects.toMatchObject<ApiError>({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry mutations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(503, { error: "try later" }));
    await expect(requestJson("/api/demo/session", { method: "POST" }, { fetcher, retryDelayMs: 0 })).rejects.toMatchObject<ApiError>({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry authentication failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(401, { error: "expired" }));
    await expect(requestJson("/api/demo/session", {}, { fetcher, retryDelayMs: 0 })).rejects.toMatchObject<ApiError>({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled mutation without retrying or claiming it failed to save", async () => {
    const fetcher = vi.fn<typeof fetch>((_path, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    await expect(requestJson("/api/settings", { method: "PATCH" }, { fetcher, timeoutMs: 10 })).rejects.toMatchObject({ status: 408, message: expect.stringContaining("may have completed") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels a retry delay when the component leaves", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(503, {}));
    const request = requestJson("/api/calls", { signal: controller.signal }, { fetcher, retryDelayMs: 500 });
    const assertion = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not fetch for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(requestJson("/api/calls", { signal: controller.signal }, { fetcher })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an HTML success page instead of passing empty data to components", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Sign in</html>", { status: 200 }));
    await expect(requestJson("/api/calls", {}, { fetcher })).rejects.toMatchObject({ status: 502 });
  });

  it("keeps authentication status when an upstream returns HTML", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Sign in</html>", { status: 401 }));
    await expect(requestJson("/api/calls", {}, { fetcher })).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("explains network failures without replaying a command", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(requestJson("/api/calls", { method: "POST" }, { fetcher })).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Check your connection") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
