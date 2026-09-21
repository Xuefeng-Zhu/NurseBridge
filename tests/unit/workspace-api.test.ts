import { describe, expect, it, vi } from "vitest";
import { ApiError, requestJson } from "../../apps/web/src/components/workspace-api";

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("workspace API reads", () => {
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
});
