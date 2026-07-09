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

// Signal:市場訊號實體(B agent 建立,C agent 追蹤,D agent 引用)
export interface Signal {
  id: string;
  slug: string | null;
  title: string;
  description: string;
  importance: number;          // 1-5
  status: string;              // discovered / tracking / matured / faded / invalid
  tags: string[];
  source_items: string[];
  created_at: Date;
  updated_at: Date;
}

// 用於 insertSignal,省略有 default 的欄位
export interface NewSignal {
  slug?: string | null;
  title: string;
  description: string;
  importance?: number;         // 預設 3
  status?: string;             // 預設 'discovered'
  tags?: string[];
  source_items?: string[];
}
