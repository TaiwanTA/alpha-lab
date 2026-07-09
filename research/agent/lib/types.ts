// LLM 相關型別
//   (llm.ts 自帶主要型別,這裡放跨 agent 共用的)

export interface SignalCandidate {
  title: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  source_item_ids: string[];
}

export interface ResearchFinding {
  observation: string;
  entities: string[];
  tags: string[];
  source: string;  // 來源 URL 或 item id
}
