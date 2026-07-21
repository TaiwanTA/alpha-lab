#!/usr/bin/env bun
// automation/commands/migrate-signal-layer.ts
//
// 後續資料回填：為既有 items 建立 1:1 低優先級 signals、
// 重映射 research_runs/paper_bets 的外鍵參考、將所有 items 標記為已分類。
//
// 必須在 applyMigration() 套用 002_signal_layer.sql 之後執行。
// 可重複執行（冪等）：插入前會先檢查既有的 signal_items。

import { db, closeDb } from "../lib/db.ts";

interface ItemRow {
  id: string;
  raw_content: string;
}

async function migrateSignalLayer(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required");
  }

  // 1. 找出所有尚未有 signal_items 記錄的 items
  const orphanItems = await db<ItemRow[]>`
    SELECT i.id, i.raw_content FROM items i
    LEFT JOIN signal_items si ON si.item_id = i.id WHERE si.item_id IS NULL
    ORDER BY i.captured_at ASC
  `;

  if (orphanItems.length === 0) {
    console.error("migrate-signal-layer: no orphan items, nothing to do");
    return;
  }

  console.error(`migrate-signal-layer: processing ${orphanItems.length} orphan items`);

  // 2. 為每個孤兒 item 建立 1:1 低優先級 signal，
  //    並透過 signal_items 建立關聯。
  let created = 0;
  for (const item of orphanItems) {
    const signalId = crypto.randomUUID();
    const title = item.raw_content.slice(0, 60).replace(/\n/g, " ").trim();

    await db.begin(async (tx) => {
      await tx`
        INSERT INTO signals (id, title, description, priority)
        VALUES (
          ${signalId},
          ${title},
          'Legacy item: imported from signal_events. Pending reclassification.',
          'low'
        )
      `;
      await tx`
        INSERT INTO signal_items (signal_id, item_id, relation)
        VALUES (${signalId}, ${item.id}, 'primary')
        ON CONFLICT DO NOTHING
      `;
    });
    created++;
  }

  console.error(`migrate-signal-layer: created ${created} legacy signals`);

  // 3. 將 research_runs.signal_id 從舊的 event_id（即原本的 item id）
  //    重映射到新的 signal id。透過 signal_items 關聯回 item。
  const remappedRuns = await db`
    UPDATE research_runs rr SET signal_id = si.signal_id
    FROM signal_items si
    WHERE si.item_id = rr.signal_id
      AND si.relation = 'primary'
      AND rr.signal_id IN (SELECT item_id FROM signal_items WHERE relation = 'primary')
  `;
  console.error(`migrate-signal-layer: remapped ${remappedRuns.count} research_runs`);

  // 4. 同樣重映射 paper_bets.signal_id
  const remappedBets = await db`
    UPDATE paper_bets pb SET signal_id = si.signal_id
    FROM signal_items si
    WHERE si.item_id = pb.signal_id
      AND si.relation = 'primary'
      AND pb.signal_id IN (SELECT item_id FROM signal_items WHERE relation = 'primary')
  `;
  console.error(`migrate-signal-layer: remapped ${remappedBets.count} paper_bets`);

  // 5. 將所有既有 items 標記為已分類（legacy）
  const marked = await db`
    UPDATE items
    SET classified_at = now(),
        classification_result = '{"legacy": true}'::jsonb
    WHERE classified_at IS NULL
  `;
  console.error(`migrate-signal-layer: marked ${marked.count} items as classified`);
}

if (import.meta.main) {
  try {
    await migrateSignalLayer();
  } catch (err) {
    console.error(
      `migrate-signal-layer: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
