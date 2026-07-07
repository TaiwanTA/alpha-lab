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
