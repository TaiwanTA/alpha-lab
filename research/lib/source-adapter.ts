// SourceAdapter 介面:每個資料來源實作這個
//   resolve:   把 config 解析成 stable id(例如 username → numeric user id)
//   fetchNew:  抓這個 source 的新 items,從 lastExternalId 之後開始
//   fetchContext: optional,給 reply / thread 等 context lookup 用

import type { RawItem } from "./types.ts";

export interface SourceAdapter {
  /** 唯一識別,例如 'x_user_timeline' */
  readonly type: string;

  /** 把 config 解析成 stable id(例如 username → numeric user id) */
  resolve(config: Record<string, unknown>): Promise<{ id: string; label: string }>;

  /** 抓這個 source 的新 items,從 lastExternalId 之後開始(包含 lastExternalId 那一則,呼叫端自己 dedup) */
  fetchNew(
    config: Record<string, unknown>,
    sourceKey: string,
    lastExternalId: string | null,
  ): AsyncIterable<RawItem>;

  /** 用 id 抓特定 items(給 context lookup 用)。沒有 context 概念的 source 可以不實作。 */
  fetchContext?(ids: string[]): Promise<RawItem[]>;
}
