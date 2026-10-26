import { afterEach, describe, expect, it, vi } from "vitest";

import { callModel, callSegmentation, ModelCallError, responsesUrl } from "./copilot-model.server";

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

  it("sends temperature and max_tokens only when the caller asks for them", async () => {
    setEnv({ META_MODEL_API_KEY: "test-key", META_MODEL_ID: "meta-test-model", META_MODEL_API_BASE_URL: "https://api.example.test/v1" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callModel("sys", "user", { temperature: 0, maxTokens: 1500 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(1500);
  });
});

describe("callModel with a photo", () => {
  it("sends the prompt and image URL as content parts", async () => {
    setEnv({ META_MODEL_API_KEY: "k", META_MODEL_ID: "meta-test-model", META_MODEL_API_BASE_URL: "https://api.example.test/v1" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callModel("sys", "look", { images: ["https://signed.example/photo.jpg"] });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "https://signed.example/photo.jpg" } },
    ]);
  });
});

describe("callSegmentation", () => {
  it("fails with not_configured and never calls the API when META_SAM_MODEL_ID is missing", async () => {
    setEnv({ META_MODEL_API_KEY: "k", META_MODEL_API_BASE_URL: "https://api.example.test/v1", META_SAM_MODEL_ID: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const err = await callSegmentation("water stain", "https://signed.example/p.jpg").catch((e: unknown) => e);
    expect((err as ModelCallError).code).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the confirmed SAM shape to /responses on the same base URL and key", async () => {
    setEnv({ META_MODEL_API_KEY: "k", META_MODEL_API_BASE_URL: "https://api.example.test/v1/", META_SAM_MODEL_ID: "sam-3.1" });
    const sse = 'data: {"type":"response.output_text.done","text":"box x1=1 y1=2 x2=30 y2=40 w=100 h=100 c=0.8 mask=AQ=="}\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callSegmentation("water stain", "https://signed.example/p.jpg");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/responses");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "sam-3.1",
      stream: true,
      metadata: { mask_encoding: "one_bit", include_confidence: "true" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "water stain" },
            { type: "input_image", image_url: "https://signed.example/p.jpg" },
          ],
        },
      ],
    });
    expect(result.modelId).toBe("sam-3.1");
    expect(result.boxes).toEqual([{ frame: 0, x1: 1, y1: 2, x2: 30, y2: 40, w: 100, h: 100, c: 0.8 }]);
  });

  it("derives /responses from a full chat-completions URL", () => {
    expect(responsesUrl("https://api.example.test/v1/chat/completions")).toBe("https://api.example.test/v1/responses");
  });
});
