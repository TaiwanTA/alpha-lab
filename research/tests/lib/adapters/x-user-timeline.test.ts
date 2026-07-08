import { test, expect, describe } from "bun:test";
import { XUserTimelineAdapter } from "../../../lib/adapters/x-user-timeline.ts";
import type { XClient, XTweetWithAuthor } from "../../../lib/x-client.ts";

function makeTweet(overrides: Partial<XTweetWithAuthor> = {}): XTweetWithAuthor {
  return {
    id: "1",
    text: "Hello world",
    created_at: "2025-07-07T12:00:00.000Z",
    author_id: "user-1",
    conversation_id: "conv-1",
    author: { id: "user-1", username: "BillAckman", name: "Bill Ackman" },
    ...overrides,
  };
}

// Helper:產生一則 reply tweet(透過 referenced_tweets)
function makeReplyTweet(parentId: string, overrides: Partial<XTweetWithAuthor> = {}): XTweetWithAuthor {
  return makeTweet({
    referenced_tweets: [{ type: "replied_to", id: parentId }],
    ...overrides,
  });
}

function makeFakeClient(
  tweets: XTweetWithAuthor[] = [],
  byIds: XTweetWithAuthor[] = [],
): XClient {
  return {
    resolveUsername: async (username: string) => ({
      id: "user-1",
      username,
      name: "Bill Ackman",
    }),
    getUserTimeline: async () => ({
      tweets,
      nextToken: null,
    }),
    getTweetsByIds: async (ids: string[]) => byIds.filter((t) => ids.includes(t.id)),
  } as unknown as XClient;
}

describe("XUserTimelineAdapter.resolve", () => {
  test("returns numeric id and @username label", async () => {
    const adapter = new XUserTimelineAdapter(makeFakeClient());
    const resolved = await adapter.resolve({ username: "BillAckman" });
    expect(resolved.id).toBe("user-1");
    expect(resolved.label).toBe("@BillAckman");
  });
});

describe("XUserTimelineAdapter.fetchNew", () => {
  test("yields tweets up to lastExternalId boundary (inclusive)", async () => {
    const tweets = [makeTweet({ id: "3" }), makeTweet({ id: "2" }), makeTweet({ id: "1" })];
    const adapter = new XUserTimelineAdapter(makeFakeClient(tweets));
    const items: string[] = [];
    for await (const item of adapter.fetchNew({}, "user-1", "1")) {
      items.push(item.external_id);
    }
    // 3, 2 yielded; 1 is the boundary and not yielded
    expect(items).toEqual(["3", "2"]);
  });

  test("yields all tweets when lastExternalId is null", async () => {
    const tweets = [makeTweet({ id: "1" }), makeTweet({ id: "2" })];
    const adapter = new XUserTimelineAdapter(makeFakeClient(tweets));
    const items: string[] = [];
    for await (const item of adapter.fetchNew({}, "user-1", null)) {
      items.push(item.external_id);
    }
    expect(items).toEqual(["1", "2"]);
  });

  test("context includes URL, author, engagement metrics", async () => {
    const tweet = makeTweet({
      id: "100",
      text: "Markets are fascinating",
      public_metrics: {
        retweet_count: 10,
        like_count: 200,
        reply_count: 5,
        quote_count: 2,
        impression_count: 5000,
      },
      lang: "en",
    });
    const adapter = new XUserTimelineAdapter(makeFakeClient([tweet]));
    const items: any[] = [];
    for await (const item of adapter.fetchNew({}, "user-1", null)) {
      items.push(item);
    }

    expect(items[0].context).toContain("Tweet by @BillAckman (id: 100)");
    expect(items[0].context).toContain("URL: https://x.com/BillAckman/status/100");
    expect(items[0].context).toContain("Markets are fascinating");
    expect(items[0].context).toContain("Likes: 200");
    expect(items[0].context).toContain("Retweets: 10");
    expect(items[0].context).toContain("Replies: 5");
    expect(items[0].context).toContain("Quotes: 2");
    expect(items[0].context).toContain("Impressions: 5000");
    expect(items[0].context).toContain("Language: en");
  });

  test("context includes 'In reply to' for replies", async () => {
    const tweet = makeReplyTweet("100", { id: "200" });
    const adapter = new XUserTimelineAdapter(makeFakeClient([tweet]));
    const items: any[] = [];
    for await (const item of adapter.fetchNew({}, "user-1", null)) {
      items.push(item);
    }
    expect(items[0].external_parent).toBe("100");
    expect(items[0].context).toContain("In reply to: 100");
  });

  test("external_parent is null for quote tweets (only replied_to counts)", async () => {
    const tweet = makeTweet({
      id: "300",
      referenced_tweets: [{ type: "quoted", id: "999" }],
    });
    const adapter = new XUserTimelineAdapter(makeFakeClient([tweet]));
    const items: any[] = [];
    for await (const item of adapter.fetchNew({}, "user-1", null)) {
      items.push(item);
    }
    expect(items[0].external_parent).toBeNull();
    expect(items[0].context).not.toContain("In reply to:");
  });

  test("external_parent picks replied_to when both quote and reply exist", async () => {
    const tweet = makeTweet({
      id: "400",
      referenced_tweets: [
        { type: "quoted", id: "111" },
        { type: "replied_to", id: "222" },
      ],
    });
    const adapter = new XUserTimelineAdapter(makeFakeClient([tweet]));
    const items: any[] = [];
    for await (const item of adapter.fetchNew({}, "user-1", null)) {
      items.push(item);
    }
    expect(items[0].external_parent).toBe("222");
  });

  test("source_label uses tweet's author (not always the monitored user)", async () => {
    // Imagine Ackman replied to someone; the parent tweet has a different author
    const parent = makeTweet({ id: "99", author: { id: "u2", username: "elonmusk", name: "Elon" } });
    const adapter = new XUserTimelineAdapter(makeFakeClient([parent]));
    const items: any[] = [];
    for await (const item of adapter.fetchNew({}, "elon-id", null)) {
      items.push(item);
    }
    expect(items[0].source_label).toBe("@elonmusk");
  });
});

describe("XUserTimelineAdapter.fetchContext", () => {
  test("returns RawItems for given ids", async () => {
    const parent = makeTweet({ id: "0", text: "original tweet" });
    const adapter = new XUserTimelineAdapter(makeFakeClient([], [parent]));
    const items = await adapter.fetchContext!(["0"]);
    expect(items).toHaveLength(1);
    expect(items[0]!.external_id).toBe("0");
    expect(items[0]!.context).toContain("original tweet");
  });

  test("returns empty array for empty input", async () => {
    const adapter = new XUserTimelineAdapter(makeFakeClient());
    const items = await adapter.fetchContext!([]);
    expect(items).toHaveLength(0);
  });
});
