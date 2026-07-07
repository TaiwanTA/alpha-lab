// 主入口:對每個 source 跑 pull
// 用法:bun run pull

import { loadConfig } from "./lib/config.ts";
import { XClient } from "./lib/x-client.ts";
import { XUserTimelineAdapter } from "./lib/adapters/x-user-timeline.ts";
import { RawWriter } from "./lib/raw-writer.ts";
import {
  initDb,
  insertItems,
  getFetchState,
  upsertFetchState,
  haveItems,
} from "./lib/db.ts";
import type { SourceConfig, RawItem } from "./lib/types.ts";
import type { SourceAdapter } from "./lib/source-adapter.ts";

// 目前支援的 adapter registry;新來源在這裡加一行
const ADAPTERS: Record<string, new (xClient: XClient) => SourceAdapter> = {
  x_user_timeline: XUserTimelineAdapter as unknown as new (
    xClient: XClient,
  ) => SourceAdapter,
};

async function pullSource(
  source: SourceConfig,
  xClient: XClient,
  rawWriter: RawWriter,
): Promise<{ newItems: number; contextItems: number }> {
  // 1. resolve + 取 state
  const adapterCtor = ADAPTERS[source.type];
  if (!adapterCtor) throw new Error(`No adapter for source type: ${source.type}`);
  const adapter = new adapterCtor(xClient);

  const resolved = await adapter.resolve(source.config);
  const state = await getFetchState(source.type, resolved.id);
  const lastExternalId = state?.last_external_id ?? null;

  console.log(
    `[${resolved.label}] starting (last_id: ${lastExternalId ?? "none"})`,
  );

  // 2. 抓新 tweets
  const newItems: RawItem[] = [];
  for await (const item of adapter.fetchNew(
    source.config,
    resolved.id,
    lastExternalId,
  )) {
    newItems.push(item);
  }

  if (newItems.length === 0) {
    console.log(`[${resolved.label}] no new tweets`);
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

  // 3. 寫磁碟 + DB
  for (const item of newItems) {
    await rawWriter.append(
      item.source_type,
      item.source_label,
      item.created_at,
      item.raw_payload,
    );
  }
  const newInserted = await insertItems(newItems);
  console.log(
    `[${resolved.label}] fetched ${newItems.length}, inserted ${newInserted} new`,
  );

  // 4. context(parent tweets) — 只在 adapter 支援時跑
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
          console.log(
            `[${resolved.label}] fetching ${missing.length} parent tweets for context`,
          );
          // X 的 lookup API 一次最多 100 個 id
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

  // 5. 更新 state
  // fetchNew yield 的順序是 newest first,所以 [0] 是最新的
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

async function main(): Promise<void> {
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

  let totalNew = 0;
  let totalContext = 0;
  for (const source of config.sources) {
    try {
      const result = await pullSource(source, xClient, rawWriter);
      totalNew += result.newItems;
      totalContext += result.contextItems;
    } catch (err) {
      console.error(`[${source.type}:${source.label}] FAILED:`, err);
    }
  }

  console.log(`[pull] done. ${totalNew} new, ${totalContext} context.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
