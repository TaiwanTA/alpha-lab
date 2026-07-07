// JSONL append writer
//   寫到 raw/<source_type>/<source_label>/<YYYY-MM>/<YYYY-MM-DD>.jsonl
//   append-only,createPath 時自動建子目錄

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface RawPath {
  dir: string;
  file: string;
}

export class RawWriter {
  constructor(private readonly root: string) {}

  /** 寫一筆 raw payload 到磁碟,回傳寫入的檔案路徑 */
  async append(
    sourceType: string,
    sourceLabel: string,
    createdAt: Date,
    payload: unknown,
  ): Promise<string> {
    const { dir, file } = this.computePath(sourceType, sourceLabel, createdAt);
    await mkdir(dir, { recursive: true });
    await appendFile(file, JSON.stringify(payload) + "\n", "utf-8");
    return file;
  }

  /** 計算路徑(測試用,append 內部也用) */
  computePath(sourceType: string, sourceLabel: string, createdAt: Date): RawPath {
    const year = createdAt.getUTCFullYear();
    const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(createdAt.getUTCDate()).padStart(2, "0");
    const safeLabel = this.sanitize(sourceLabel);
    const dir = join(this.root, sourceType, safeLabel, `${year}-${month}`);
    const file = join(dir, `${year}-${month}-${day}.jsonl`);
    return { dir, file };
  }

  private sanitize(label: string): string {
    return label.replace(/[^a-zA-Z0-9_-]/g, "_");
  }
}
