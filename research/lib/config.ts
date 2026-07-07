// 讀 sources.json

import { readFileSync } from "node:fs";
import type { SourcesFile } from "./types.ts";

export function loadConfig(path: string): SourcesFile {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as SourcesFile;
}
