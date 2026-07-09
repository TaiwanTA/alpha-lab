// A workflow 包裝:把 `pull.ts` 的 main 邏輯搬進 pullStep(),作 `aWorkflow()` 的單一步驟。
//
// A 業務本身沒有獨立 workflow ID(`pull.ts` 的 `if (import.meta.main)` CLI
// path 保留),這裡 wrap 在 workflow SDK 內作可觀察的 step(workflow_runs +
// workflow_steps 寫進 DB),提供 Step 7b 的 `/a` 觸發 endpoint。
//
// 不做事:跟原本 pull.ts 完全等價;DB schema、adapter、x-client 都不動。
// 為什麼不 import lib/logger(用 console.log 而非)見 workflow/b.ts 頭註
// (workflow SDK node-module-error plugin 對 module-level node imports 嚴格)。

import { initDb } from "../lib/db.ts";
import type { SourceConfig, RawItem } from "../lib/types.ts";
import type { SourceAdapter } from "../lib/source-adapter.ts";
import { loadConfig } from "../lib/config.ts";
import { XClient } from "../lib/x-client.ts";
import { XUserTimelineAdapter } from "../lib/adapters/x-user-timeline.ts";
import { RawWriter } from "../lib/raw-writer.ts";
import {
  getFetchState,
  upsertFetchState,
  insertItems,
  haveItems,
} from "../lib/db.ts";

// 跟 pull.ts 同樣的 adapter registry;pull.ts 加新來源時,這裡也跟著加
const ADAPTERS: Record<string, new (xClient: XClient) => SourceAdapter> = {
  x_user_timeline: XUserTimelineAdapter as unknown as new (
    xClient: XClient,
  ) => SourceAdapter,
};

export interface PullStepResult {
  source: string;
  newItems: number;
  contextInserted: number;
}

// 把 pull.ts::pullSource 搬進來,作為單一 step 的工作單元
async function pullSource(
  source: SourceConfig,
  xClient: XClient,
  rawWriter: RawWriter,
): Promise<{ newItems: number; contextItems: number }> {
  const adapterCtor = ADAPTERS[source.type];
  if (!adapterCtor) throw new Error(`No adapter for source type: ${source.type}`);
  const adapter = new adapterCtor(xClient);

  const resolved = await adapter.resolve(source.config);
  const state = await getFetchState(source.type, resolved.id);
  const lastExternalId = state?.last_external_id ?? null;

  const newItems: RawItem[] = [];
  for await (const item of adapter.fetchNew(
    source.config,
    resolved.id,
    lastExternalId,
  )) {
    newItems.push(item);
  }

  if (newItems.length === 0) {
    await upsertFetchState({
      source_type: source.type,
      source_key: resolved.id,
      source_label: resolved.label,
      last_external_id: lastExternalId,
      last_run_at: new Date(),
      last_status: "ok",
    });
    return { newItems: 0, contextItems: 0 };
  }

  for (const item of newItems) {
    await rawWriter.append(
      item.source_type,
      item.source_label,
      item.created_at,
      item.raw_payload,
    );
  }
  const newInserted = await insertItems(newItems);

  let contextInserted = 0;
  if (adapter.fetchContext) {
    const cfg = source.config as { fetch_parent_context?: boolean };
    if (cfg.fetch_parent_context) {
      const parentIds = [
        ...new Set(
          newItems
            .map((i) => i.external_parent)
            .filter((id): id is string => id !== null),
        ),
      ];
      if (parentIds.length > 0) {
        const have = await haveItems(source.type, parentIds);
        const missing = parentIds.filter((id) => !have.has(id));
        if (missing.length > 0) {
          for (let i = 0; i < missing.length; i += 100) {
            const batch = missing.slice(i, i + 100);
            const contextItems = await adapter.fetchContext(batch);
            for (const item of contextItems) {
              await rawWriter.append(
                item.source_type,
                item.source_label,
                item.created_at,
                item.raw_payload,
              );
            }
            contextInserted += await insertItems(contextItems);
          }
        }
      }
    }
  }

  await upsertFetchState({
    source_type: source.type,
    source_key: resolved.id,
    source_label: resolved.label,
    last_external_id: newItems[0]!.external_id,
    last_run_at: new Date(),
    last_status: "ok",
  });

  return { newItems: newInserted, contextItems: contextInserted };
}

// use step:每個 source 跑一次 pullSource,給每個 source 各自一條 step 紀錄。
// 注意:workflow 內部不能做 top-level await,所以整個 step 函式包在一個 async IIFE 內。
async function pullStep(): Promise<PullStepResult[]> {
  "use step";

  const databaseUrl = process.env.DATABASE_URL;
  const xToken = process.env.X_BEARER_TOKEN;
  const rawRoot = process.env.RAW_ROOT ?? "../raw";
  const configPath = process.env.SOURCES_PATH ?? "./sources.json";

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!xToken) throw new Error("X_BEARER_TOKEN is required");

  await initDb();
  const config = loadConfig(configPath);
  const xClient = new XClient(xToken);
  const rawWriter = new RawWriter(rawRoot);

  const results: PullStepResult[] = [];
  for (const source of config.sources) {
    try {
      const r = await pullSource(source, xClient, rawWriter);
      results.push({
        source: source.label,
        newItems: r.newItems,
        contextInserted: r.contextItems,
      });
    } catch (err) {
      console.log(`[A-workflow] source ${source.label} failed: ${err instanceof Error ? err.message : err}`);
      results.push({ source: source.label, newItems: 0, contextInserted: 0 });
    }
  }

  return results;
}

// orchestrator:跑一次 pullStep,聚合 totals 後回傳
export async function aWorkflow(): Promise<{
  sources: PullStepResult[];
  totalNew: number;
  totalContext: number;
}> {
  "use workflow";
  const results = await pullStep();
  const totalNew = results.reduce((s, r) => s + r.newItems, 0);
  const totalContext = results.reduce((s, r) => s + r.contextInserted, 0);
  console.log(`[A-workflow] done sources=${results.length} total_new=${totalNew} total_context=${totalContext}`);
  return { sources: results, totalNew, totalContext };
}
