import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { XClient, XApiError } from "../../lib/x-client.ts";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mockFetch>;

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = (url: string | URL | Request) => {
    calls.push(String(url));
    return Promise.resolve(impl(String(url)));
  };
  (fn as any).mock = { calls };
  return fn as any;
}

beforeEach(() => {
  fetchMock = mockFetch(() => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("XClient.resolveUsername", () => {
  test("calls /users/by/username/<name> with bearer auth", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({ data: { id: "123", username: "BillAckman", name: "Bill" } }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new XClient("test-token");
    const user = await client.resolveUsername("BillAckman");

    expect(user.id).toBe("123");
    expect(user.username).toBe("BillAckman");
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchMock.mock.calls[0]).toContain("/users/by/username/BillAckman");
    expect(fetchMock.mock.calls[0]).toContain("api.x.com");
  });

  test("throws XApiError on 401", async () => {
    fetchMock = mockFetch(() => new Response("Unauthorized", { status: 401 }));
    globalThis.fetch = fetchMock;

    const client = new XClient("bad-token");
    await expect(client.resolveUsername("x")).rejects.toThrow(XApiError);
  });

  test("retries on 429 then succeeds", async () => {
    let callCount = 0;
    fetchMock = mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: {
            "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 1),
          },
        });
      }
      return new Response(
        JSON.stringify({ data: { id: "1", username: "x", name: "x" } }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const client = new XClient("token");
    const user = await client.resolveUsername("x");
    expect(user.id).toBe("1");
    expect(callCount).toBe(2);
  });
});

describe("XClient.getUserTimeline", () => {
  test("parses response and merges author from includes", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "t1",
              text: "hello",
              created_at: "2025-07-01T00:00:00.000Z",
              author_id: "u1",
              conversation_id: "c1",
            },
          ],
          includes: { users: [{ id: "u1", username: "BillAckman", name: "Bill" }] },
          meta: { next_token: "tok1" },
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new XClient("token");
    const page = await client.getUserTimeline("u1");

    expect(page.tweets).toHaveLength(1);
    expect(page.tweets[0]!.author.username).toBe("BillAckman");
    expect(page.nextToken).toBe("tok1");
  });

  test("returns null nextToken when no pagination", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "t1",
              text: "hello",
              created_at: "2025-07-01T00:00:00.000Z",
              author_id: "u1",
              conversation_id: "c1",
            },
          ],
          includes: { users: [{ id: "u1", username: "u", name: "u" }] },
          meta: {},
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new XClient("token");
    const page = await client.getUserTimeline("u1");
    expect(page.nextToken).toBeNull();
  });
});

describe("XClient.getTweetsByIds", () => {
  test("joins ids with comma", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({ data: [], includes: { users: [] } }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new XClient("token");
    await client.getTweetsByIds(["1", "2", "3"]);
    expect(fetchMock.mock.calls[0]).toContain("ids=1%2C2%2C3");
  });

  test("returns empty array for empty input without making request", async () => {
    const client = new XClient("token");
    const tweets = await client.getTweetsByIds([]);
    expect(tweets).toHaveLength(0);
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  test("handles missing data field gracefully", async () => {
    fetchMock = mockFetch(() =>
      new Response(JSON.stringify({ includes: { users: [] } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;

    const client = new XClient("token");
    const tweets = await client.getTweetsByIds(["1"]);
    expect(tweets).toHaveLength(0);
  });
});
