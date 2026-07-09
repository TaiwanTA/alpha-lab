// 共用型別

// RawItem:adapter 產出的單一資料項
//   context      → 進 DB (LLM 直接讀)
//   raw_payload  → 進磁碟 (source of truth)
export interface RawItem {
  source_type: string;
  source_label: string;
  external_id: string;
  external_parent: string | null;
  created_at: Date;
  context: string;
  raw_payload: unknown;
}

// fetch_state 對應的 row
export interface FetchState {
  source_type: string;
  source_key: string;
  source_label: string;
  last_external_id: string | null;
  last_run_at: Date | null;
  last_status: string | null;
}

// sources.json 對應的單一 source
export interface SourceConfig {
  type: string;
  label: string;
  config: Record<string, unknown>;
}

export interface SourcesFile {
  sources: SourceConfig[];
}

// Signal 的合法 status,對應 DB CHECK constraint(migration 003)
export type SignalStatus = "discovered" | "tracking" | "matured" | "faded" | "invalid";

// Signal:市場訊號實體(B agent 建立,C agent 追蹤,D agent 引用)
export interface Signal {
  id: string;
  slug: string | null;
  title: string;
  description: string;
  importance: number;          // 1-5
  status: SignalStatus;        // discovered / tracking / matured / faded / invalid
  tags: string[];
  source_items: string[];
  created_at: Date;
  updated_at: Date;
}

// items 表的 row(extend RawItem,加 DB-only 欄位 fetched_at + 給 B agent 的 processed_at)
// 給 B agent 用,因為它讀 items 表的「未處理」部分
export interface ItemRow extends RawItem {
  fetched_at: Date;
  processed_at: Date | null;
}

// 用於 insertSignal,省略有 default 的欄位
export interface NewSignal {
  slug?: string | null;
  title: string;
  description: string;
  importance?: number;         // 預設 3
  status?: string;             // 預設 'discovered'(由 db.ts 用 validateSignalStatus 收斂)
  tags?: string[];
  source_items?: string[];
}
