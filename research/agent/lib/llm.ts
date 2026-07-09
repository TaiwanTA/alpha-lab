// LLM call wrapper — 用 OpenRouter API(支援 15+ providers)
//   不引入 SDK,純 fetch,跟 x-client / hindsight-client 同 pattern
//   OpenRouter API: https://openrouter.ai/api/v1/chat/completions

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
  if (options?.json) {
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

      return {
        content,
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
