import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { ask, askMessages, LlmError } from "../../../agent/lib/llm.ts";

const originalFetch = globalThis.fetch;
let fetchMock: any;

function mockFetch(status: number, body: unknown) {
  const calls: any[] = [];
  const fn: any = (url: string, opts: any) => {
    calls.push({ url, opts });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  fn.mock = { calls };
  return fn;
}

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  fetchMock = mockFetch(200, {
    choices: [{ message: { content: "hello world" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: "test-model",
  });
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
});

describe("ask", () => {
  test("sends system + user messages to OpenRouter", async () => {
    let calledArgs: any;
    fetchMock = (url: string, opts: any) => {
      calledArgs = { url, opts };
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "test-model",
      }), { status: 200 }));
    };
    globalThis.fetch = fetchMock;

    const result = await ask("What is NVDA?", { system: "You are a stock analyst." });

    expect(result.content).toBe("ok");
    expect(calledArgs.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(calledArgs.opts.body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("You are a stock analyst.");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("What is NVDA?");
  });

  test("without system prompt, sends only user message", async () => {
    let calledArgs: any;
    fetchMock = (url: string, opts: any) => {
      calledArgs = { url, opts };
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: {},
        model: "test-model",
      }), { status: 200 }));
    };
    globalThis.fetch = fetchMock;

    await ask("Hello");
    const body = JSON.parse(calledArgs.opts.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  test("returns usage info", async () => {
    const result = await ask("test");
    expect(result.usage.totalTokens).toBe(15);
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
    expect(result.model).toBe("test-model");
  });

  test("respects custom model override", async () => {
    let calledArgs: any;
    fetchMock = (_url: string, opts: any) => {
      calledArgs = opts;
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: {},
        model: "custom-model",
      }), { status: 200 }));
    };
    globalThis.fetch = fetchMock;

    await ask("test", { model: "anthropic/claude-3.5-sonnet" });
    expect(JSON.parse(calledArgs.body).model).toBe("anthropic/claude-3.5-sonnet");
  });

  test("json option sets response_format", async () => {
    let calledArgs: any;
    fetchMock = (_url: string, opts: any) => {
      calledArgs = opts;
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '{"a":1}' } }],
        usage: {},
        model: "test-model",
      }), { status: 200 }));
    };
    globalThis.fetch = fetchMock;

    await ask("list items", { json: true });
    expect(JSON.parse(calledArgs.body).response_format).toEqual({ type: "json_object" });
  });

  test("throws LlmError on 4xx", async () => {
    fetchMock = () => Promise.resolve(new Response("Bad request", { status: 400 }));
    globalThis.fetch = fetchMock;
    await expect(ask("test")).rejects.toThrow(LlmError);
  });

  test("throws on missing API key", async () => {
    delete process.env.LLM_API_KEY;
    await expect(ask("test")).rejects.toThrow("LLM_API_KEY is required");
  });

  test("throws on empty choices", async () => {
    fetchMock = () => Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    globalThis.fetch = fetchMock;
    await expect(ask("test")).rejects.toThrow("no choices");
  });

  test("maxTokens is sent when provided", async () => {
    let calledArgs: any;
    fetchMock = (_url: string, opts: any) => {
      calledArgs = opts;
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: {},
        model: "test-model",
      }), { status: 200 }));
    };
    globalThis.fetch = fetchMock;

    await ask("test", { maxTokens: 500 });
    expect(JSON.parse(calledArgs.body).max_tokens).toBe(500);
  });

  test("custom base URL via env", async () => {
    process.env.LLM_BASE_URL = "https://custom.api.com/v1";
    let calledUrl = "";
    fetchMock = (url: string) => {
      calledUrl = url;
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: {},
        model: "test-model",
      }), { status: 200 }));
    };
    globalThis.fetch = fetchMock;

    await ask("test");
    expect(calledUrl).toBe("https://custom.api.com/v1/chat/completions");
  });

  test("LlmError carries status and body", async () => {
    fetchMock = () =>
      Promise.resolve(new Response("Bad request", { status: 400 }));
    globalThis.fetch = fetchMock;
    let err: unknown;
    try {
      await ask("test");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(400);
    expect((err as LlmError).body).toBe("Bad request");
  });

  test("retries on TypeError (network error)", async () => {
    let callCount = 0;
    fetchMock = () => {
      callCount++;
      if (callCount < 3) {
        // TypeError — bun fetch throws "fetch failed" on network/DNS issues
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: {},
            model: "test-model",
          }),
          { status: 200 },
        ),
      );
    };
    globalThis.fetch = fetchMock;
    const result = await ask("test");
    expect(result.content).toBe("ok");
    expect(callCount).toBe(3);
  });

  test("does NOT retry on deterministic error (no choices)", async () => {
    let callCount = 0;
    fetchMock = () => {
      callCount++;
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    };
    globalThis.fetch = fetchMock;
    await expect(ask("test")).rejects.toThrow(/no choices/);
    // Should NOT retry — only 1 call
    expect(callCount).toBe(1);
  });

  test("does NOT retry on LlmError for 4xx", async () => {
    let callCount = 0;
    fetchMock = () => {
      callCount++;
      return Promise.resolve(new Response("Bad request", { status: 400 }));
    };
    globalThis.fetch = fetchMock;
    await expect(ask("test")).rejects.toThrow(LlmError);
    expect(callCount).toBe(1);
  });
});

describe("askMessages", () => {
  test("passes message array directly", async () => {
    let calledArgs: any;
    fetchMock = (_url: string, opts: any) => {
      calledArgs = opts;
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: {},
        model: "test-model",
      }), { status: 200 }));
    };
    globalThis.fetch = fetchMock;

    const messages = [
      { role: "system" as const, content: "You are helpful." },
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello!" },
      { role: "user" as const, content: "How are you?" },
    ];
    await askMessages(messages);
    expect(JSON.parse(calledArgs.body).messages).toHaveLength(4);
  });
});
