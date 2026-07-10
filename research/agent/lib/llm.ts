// LLM call wrapper — 純 fetch,跟 x-client / hindsight-client 同 pattern
//
// Provider 設計:用 OpenAI Chat Completions 相容 API(/v1/chat/completions),
// 走 `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` 來切換 provider。當前 VM 用 MiniMax
// (https://api.minimaxi.chat/v1,model `MiniMax-M3`),但本地 dev 或 CI 用 OpenRouter
// (https://openrouter.ai/api/v1,model `minimax/minimax-m3`)也相容。
//
// MiniMax 特殊處理:MiniMax-M3 是 thinking model,在 `response_format=json_object`
// 模式下仍會在 content 前面輸出 ichte 區塊,破壞 consumer 的 JSON.parse(見下方
// isMiniMax 判斷 + extractJsonObject())。OpenRouter 的 minimax 是包裝版,不會;
// 只有直連 MiniMax native API 才會碰到。

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "minimax/minimax-m3";
const DEFAULT_LLM_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export class LlmError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`LLM API error ${status}: ${body.slice(0, 300)}`);
    this.name = "LlmError";
  }
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AskOptions {
  /** 系統提示詞,optional */
  system?: string;
  /** 模型覆寫(預設從 env 讀) */
  model?: string;
  /** 溫度,0-2,預設 0.7 */
  temperature?: number;
  /** 最大 token 數 */
  maxTokens?: number;
  /** 回傳 JSON 格式(設定後 response_format = json_object) */
  json?: boolean;
  /** 逾時(ms),預設 60000 */
  timeout?: number;
}

export interface AskResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

/** 單次 LLM call。回傳 AskResult(含 content + usage)。 */
export async function ask(
  prompt: string,
  options?: AskOptions,
): Promise<AskResult> {
  const messages: LlmMessage[] = [];
  if (options?.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: prompt });
  return askMessages(messages, options);
}

/** 用 message array 做 LLM call。給 multi-turn 對話用。 */
export async function askMessages(
  messages: LlmMessage[],
  options?: AskOptions,
): Promise<AskResult> {
  const baseUrl = (process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.LLM_API_KEY;
  const model = options?.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options?.timeout ?? DEFAULT_LLM_TIMEOUT_MS;

  if (!apiKey) {
    throw new Error("LLM_API_KEY is required (set in .env)");
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options?.temperature ?? 0.7,
  };
  if (options?.maxTokens !== undefined) {
    body.max_tokens = options.maxTokens;
  }
  // MiniMax-M3 是 thinking model,且在 response_format=json_object 模式下仍會輸出
  // thinking(ichte 區塊在 content 內),導致 JSON.parse 在 content 開頭的 '<' 失敗。
  // 對 MiniMax:
  //   - 停用 thinking(讓 LLM 直接回純 JSON)
  //   - 不設 response_format(json_object + thinking 衝突,MiniMax 會 ignore response_format)
  //   - 改靠 SYSTEM_PROMPT 要求 LLM 純 JSON output,再用 extractJsonObject() 從 content 內解
  // 非 MiniMax 模型保留 response_format,行為不變
  const isMiniMax =
    process.env.LLM_BASE_URL?.includes("minimaxi.chat") ||
    (process.env.LLM_MODEL ?? "").toLowerCase().startsWith("minimax");
  if (isMiniMax) {
    body.thinking = { type: "disabled" };
  } else if (options?.json) {
    body.response_format = { type: "json_object" };
  }

  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (
        res.status === 408 ||
        res.status === 429 ||
        res.status >= 500
      ) {
        await res.body?.cancel();
        // Jitter 防止多 job 並發 thundering herd
        const baseMs = 1000 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 250);
        await sleep(baseMs + jitter);
        attempt++;
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new LlmError(res.status, text);
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        model?: string;
      };
      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error("LLM API returned no choices");
      }

      const content = choice.message?.content;
      // finish_reason 非法狀態(只有 content_filter 才該 throw;
      // length / tool_calls 都可能有 content,正常處理)
      if (choice.finish_reason === "content_filter") {
        throw new LlmError(
          451,
          "LLM API returned content_filter — content blocked by provider",
        );
      }
      if (content === undefined || content === null) {
        throw new Error("LLM API returned choice without content");
      }

      // MiniMax / 其他 thinking model 在 json mode 下可能仍輸出 reasoning 在 content 前面,
      // 例如「 ichte 分析...」。這導致 consumer 做 JSON.parse(content) 直接失敗。
      // 若 caller 要求 json,我們自動 extract content 內最後一個 {...} 區塊才回傳。
      // 對正常純 JSON 輸出不影響(findLastJsonBlock 直接回整個 content)。
      const finalContent = options?.json ? extractJsonObject(content) : content;

      return {
        content: finalContent,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        model: data.model ?? model,
      };
    } catch (err) {
      // 只 retry transient 錯誤:AbortError(超時) + TypeError(網路斷/DNS 失敗,Bun fetch 在這種情況下丟 TypeError)
      // 不 retry:deterministic throws(LlmError for 4xx API errors, SyntaxError for JSON
      // parse failure, Error for no choices / missing content)這些重試沒意義,會浪費 3 次大約同樣的失敗
      const isTransientError =
        err instanceof Error &&
        (err.name === "AbortError" || err instanceof TypeError);

      if (!isTransientError) throw err;
      if (attempt >= MAX_ATTEMPTS - 1) {
        // 跟 5xx-retry 路徑用盡時的 throw LlmError(504) 對稱
        throw new LlmError(
          504,
          `LLM request failed after ${MAX_ATTEMPTS} attempts (${err.name}: ${err.message})`,
        );
      }
      const baseMs = 1000 * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(baseMs + jitter);
      attempt++;
    } finally {
      clearTimeout(timer);
    }
  }

  // 504 = 跟 HTTP gateway timeout 同義,比 599 自訂更標準
  throw new LlmError(
    504,
    `LLM request failed after ${MAX_ATTEMPTS} attempts`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 從 LLM content 內 extract JSON object:
//   - 若 content 已是純 JSON(以 { 開頭),直接回整個 content
//   - 若 content 含 markdown ```json{...}``` 或夾雜 reasoning 文字,
//     抓最後一個 {...} 區塊(最後一個可能才是最終 JSON output)
// 思考模型(thinking model)常會在 JSON 前面輸出 reasoning,造成 consumer
// JSON.parse 在 content 開頭就失敗;這個 helper 把那段剝掉。
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  // Fast path:已經是合法 JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // 繼續嘗試 extract
  }
  // 找最後一個 { 開始、對應 } 結束的區塊(從尾巴往回找)
  // 用 stack-based brace matching 處理 nested object + 字串內 brace
  const lastOpen = trimmed.lastIndexOf("{");
  if (lastOpen === -1) return raw;  // 沒找到 { 放棄,回原 content 讓 consumer throw
  // 從 lastOpen 往後走找對應的 } (nested brace matching)
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = lastOpen; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(lastOpen, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // 不是合法 JSON,繼續找下一個 }
        }
      }
    }
  }
  return raw;  // fallback:回原 content,讓 consumer 的 JSON.parse throw 給出對 diagnostics
}
