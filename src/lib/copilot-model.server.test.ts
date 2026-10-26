import { afterEach, describe, expect, it, vi } from "vitest";

import { callModel, ModelCallError } from "./copilot-model.server";

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("callModel", () => {
  it("fails with not_configured and never calls the API when the key is missing", async () => {
    setEnv({ META_MODEL_API_KEY: "", META_MODEL_ID: "meta-test-model", META_MODEL_API_BASE_URL: "https://api.example.test/v1" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const err = await callModel("sys", "user").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).code).toBe("not_configured");
    expect((err as ModelCallError).modelId).toBe("meta-test-model");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a system + user chat-completions request with the key as a Bearer token", async () => {
    setEnv({ META_MODEL_API_KEY: "test-key", META_MODEL_ID: "meta-test-model", META_MODEL_API_BASE_URL: "https://api.example.test/v1/" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: " Hi Sarah " } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callModel("RULES", "FACTS");
    expect(result).toEqual({ text: "Hi Sarah", modelId: "meta-test-model" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "meta-test-model",
      messages: [
        { role: "system", content: "RULES" },
        { role: "user", content: "FACTS" },
      ],
    });
  });

  it("fails with an http error code when the API returns a non-OK status", async () => {
    setEnv({ META_MODEL_API_KEY: "test-key", META_MODEL_ID: "meta-test-model", META_MODEL_API_BASE_URL: "https://api.example.test/v1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));

    const err = await callModel("sys", "user").catch((e: unknown) => e);
    expect((err as ModelCallError).code).toBe("http_401");
  });
});
