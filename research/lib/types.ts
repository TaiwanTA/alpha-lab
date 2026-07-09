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

// 市場訊號(signals)狀態流轉:
//   discovered → tracking → matured
//                         → faded
//                         → invalid
export type SignalStatus =
  | 'discovered'
  | 'tracking'
  | 'matured'
  | 'faded'
  | 'invalid';

// signals 表的完整 row
export interface Signal {
  id: string;
  slug: string;
  title: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  status: SignalStatus;
  tags: string[];
  source_items: string[];
  created_at: Date;
  updated_at: Date;
}

// 寫入用的最小欄位:id / timestamps 由 DB 端 gen_random_uuid() / now() 產生
//   id 為 optional — 多數情況由 DB 自動生成;
//   bulk insert 時若要觸發 ON CONFLICT (id) DO NOTHING 需明確帶 id
export interface NewSignal {
  id?: string;
  slug?: string;
  title: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  status?: SignalStatus;
  tags?: string[];
  source_items?: string[];
}
