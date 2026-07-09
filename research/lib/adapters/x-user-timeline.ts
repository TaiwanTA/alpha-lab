// X user timeline adapter
//   把 X timeline 攤成 RawItem,context 是 LLM 可讀的格式化文字
//   reply 的 parent 透過 fetchContext(lookup API)補上

import type { SourceAdapter } from "../source-adapter.ts";
import type { RawItem } from "../types.ts";
import type { XClient, XTweetWithAuthor } from "../x-client.ts";

interface XUserTimelineConfig {
  username: string;
  fetch_parent_context?: boolean;
  max_tweets_per_run?: number;
  /** 首跑(lastExternalId 為 null 時)往回拉幾天的推文。
   *  之後增量跑不用,用 lastExternalId 作為邊界即可。
   *  預設 3 天。預測性系統中,過去資料價值低,不需要回填太多。
   */
  initial_backfill_days?: number;
}

// 從 referenced_tweets 抓出 reply 的 parent(replied_to type)的 id
// X API v2 把 reply 資訊放在 referenced_tweets 陣列裡,沒有獨立欄位
function extractReplyParentId(tweet: XTweetWithAuthor): string | null {
  const refs = tweet.referenced_tweets;
  if (!refs || refs.length === 0) return null;
  const reply = refs.find((r) => r.type === "replied_to");
  return reply?.id ?? null;
}

export class XUserTimelineAdapter implements SourceAdapter {
  readonly type = "x_user_timeline";

  constructor(private readonly xClient: XClient) {}

  async resolve(
    config: Record<string, unknown>,
  ): Promise<{ id: string; label: string }> {
    const cfg = config as unknown as XUserTimelineConfig;
    const user = await this.xClient.resolveUsername(cfg.username);
    return { id: user.id, label: `@${user.username}` };
  }

  async *fetchNew(
    config: Record<string, unknown>,
    sourceKey: string,
    lastExternalId: string | null,
  ): AsyncIterable<RawItem> {
    const cfg = config as unknown as XUserTimelineConfig;
    const maxTweets = cfg.max_tweets_per_run ?? 1000;
    const backfillDays = cfg.initial_backfill_days ?? 3;

    // 首跑無邊界:用 start_time 限制往回拉,避免一次拉進幾個月的歷史垃圾
    // 增量跑:不需要 start_time,用 lastExternalId 邊界就夠
    const startTime: Date | undefined =
      lastExternalId === null
        ? new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000)
        : undefined;

    let nextToken: string | undefined;
    let yielded = 0;

    while (yielded < maxTweets) {
      const page = await this.xClient.getUserTimeline(
        sourceKey,
        nextToken,
        startTime,
      );
      for (const tweet of page.tweets) {
        // 遇到上次處理過的 id 就停(包含等於,所以會 dedup 上次的最後一筆)
        if (lastExternalId && tweet.id === lastExternalId) return;
        yield this.toRawItem(tweet);
        yielded++;
        if (yielded >= maxTweets) break;
      }
      if (!page.nextToken) break;
      nextToken = page.nextToken;
    }
  }

  async fetchContext(ids: string[]): Promise<RawItem[]> {
    if (ids.length === 0) return [];
    const tweets = await this.xClient.getTweetsByIds(ids);
    return tweets.map((t) => this.toRawItem(t));
  }

  private toRawItem(tweet: XTweetWithAuthor): RawItem {
    const createdAt = new Date(tweet.created_at);
    const parentId = extractReplyParentId(tweet);
    return {
      source_type: this.type,
      source_label: `@${tweet.author.username}`,
      external_id: tweet.id,
      external_parent: parentId,
      created_at: createdAt,
      context: formatContext(tweet, parentId),
      raw_payload: tweet,
    };
  }
}

function formatContext(tweet: XTweetWithAuthor, parentId: string | null): string {
  const lines: string[] = [];
  lines.push(`Tweet by @${tweet.author.username} (id: ${tweet.id})`);
  lines.push(`Posted: ${tweet.created_at}`);
  lines.push(`URL: https://x.com/${tweet.author.username}/status/${tweet.id}`);
  if (parentId) {
    lines.push(`In reply to: ${parentId}`);
  }
  if (tweet.lang) {
    lines.push(`Language: ${tweet.lang}`);
  }
  lines.push("");
  lines.push("[Content]");
  lines.push(tweet.text);

  const m = tweet.public_metrics;
  if (m) {
    lines.push("");
    lines.push("[Engagement]");
    if (m.retweet_count !== undefined) lines.push(`Retweets: ${m.retweet_count}`);
    if (m.reply_count !== undefined) lines.push(`Replies: ${m.reply_count}`);
    if (m.like_count !== undefined) lines.push(`Likes: ${m.like_count}`);
    if (m.quote_count !== undefined) lines.push(`Quotes: ${m.quote_count}`);
    if (m.impression_count !== undefined) lines.push(`Impressions: ${m.impression_count}`);
  }
  return lines.join("\n");
}
