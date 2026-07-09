// X API v2 client
//   - Bearer token auth
//   - 429 自動 retry(看 x-rate-limit-reset header)
//   - 5xx 自動 retry(指數 backoff)
//   - 4xx 直接 throw

import { createLogger } from "./logger.ts";

const BASE = "https://api.x.com/2";
const log = createLogger("x-client");

export class XApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`X API error ${status}: ${body.slice(0, 200)}`);
  }
}

export interface XUser {
  id: string;
  username: string;
  name: string;
}

export interface XReferencedTweet {
  type: "replied_to" | "quoted" | "retweeted";
  id: string;
}

export interface XApiTweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  conversation_id: string;
  referenced_tweets?: XReferencedTweet[];
  lang?: string;
  entities?: Record<string, unknown>;
  public_metrics?: Record<string, number>;
}

export interface XTweetWithAuthor extends XApiTweet {
  author: XUser;
}

export interface TimelinePage {
  tweets: XTweetWithAuthor[];
  nextToken: string | null;
}

export class XClient {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    let attempt = 0;
    const maxAttempts = 5;

    while (attempt < maxAttempts) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "alpha-lab-pipeline/0.1",
        },
      });

      if (res.status === 429) {
        const reset = res.headers.get("x-rate-limit-reset");
        const waitSec = reset
          ? Math.max(0, parseInt(reset, 10) - Math.floor(Date.now() / 1000))
          : 60;
        const waitMs = (waitSec + 1) * 1000;
        log.withMetadata({ waitMs, path }).warn("rate limited");
        await sleep(waitMs);
        attempt++;
        continue;
      }

      if (res.status >= 500) {
        const waitMs = 1000 * Math.pow(2, attempt);
        log.withMetadata({ status: res.status, waitMs, path }).warn("server error, retrying");
        await sleep(waitMs);
        attempt++;
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new XApiError(res.status, body);
      }

      return (await res.json()) as T;
    }

    throw new Error(`[X API] failed after ${maxAttempts} attempts: ${path}`);
  }

  async resolveUsername(username: string): Promise<XUser> {
    const res = await this.request<{ data: XUser }>(
      `/users/by/username/${encodeURIComponent(username)}`,
    );
    return res.data;
  }

  async getUserTimeline(
    userId: string,
    paginationToken?: string,
    startTime?: Date,
  ): Promise<TimelinePage> {
    const params: Record<string, string> = {
      max_results: "100",
      "tweet.fields":
        "created_at,conversation_id,referenced_tweets,lang,entities,public_metrics",
      expansions: "author_id",
    };
    if (paginationToken) params.pagination_token = paginationToken;
    if (startTime) {
      // X API v2 要 ISO 8601,且拒絕毫秒/奈秒,只接受秒精度
      params.start_time = startTime.toISOString().split(".")[0] + "Z";
    }

    const res = await this.request<{
      data: XApiTweet[];
      includes?: { users?: XUser[] };
      meta?: { next_token?: string };
    }>(`/users/${encodeURIComponent(userId)}/tweets`, params);

    return {
      tweets: this.mergeAuthors(res.data, res.includes?.users ?? []),
      nextToken: res.meta?.next_token ?? null,
    };
  }

  async getTweetsByIds(ids: string[]): Promise<XTweetWithAuthor[]> {
    if (ids.length === 0) return [];
    const res = await this.request<{
      data?: XApiTweet[];
      includes?: { users?: XUser[] };
    }>("/tweets", {
      ids: ids.join(","),
      "tweet.fields":
        "created_at,conversation_id,referenced_tweets,lang,entities,public_metrics",
      expansions: "author_id",
    });

    return this.mergeAuthors(res.data ?? [], res.includes?.users ?? []);
  }

  private mergeAuthors(tweets: XApiTweet[], users: XUser[]): XTweetWithAuthor[] {
    const usersById = new Map<string, XUser>();
    for (const u of users) usersById.set(u.id, u);

    return tweets.map((t) => ({
      ...t,
      author: usersById.get(t.author_id) ?? {
        id: t.author_id,
        username: "unknown",
        name: "unknown",
      },
    }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
