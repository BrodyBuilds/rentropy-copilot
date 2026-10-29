import { afterEach, describe, expect, it, vi } from "vitest";

import { callModel } from "./copilot-model.server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("callModel timeout", () => {
  it("keeps the 30s default and honors a per-call timeoutMs", async () => {
    vi.stubEnv("META_MODEL_API_KEY", "test-key");
    vi.stubEnv("META_MODEL_ID", "meta-test-model");
    vi.stubEnv("META_MODEL_API_BASE_URL", "https://api.example.test/v1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
      ),
    );
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await callModel("sys", "user");
    await callModel("sys", "user", { timeoutMs: 60000 });

    expect(timeoutSpy.mock.calls.map((c) => c[0])).toEqual([30000, 60000]);
  });
});
