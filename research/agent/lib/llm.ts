// LLM call wrapper — 用 OpenRouter API(支援 15+ providers)
//   不引入 SDK,純 fetch,跟 x-client / hindsight-client 同 pattern
//   OpenRouter API: https://openrouter.ai/api/v1/chat/completions

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "minimax/MiniMax-M3";

export class LlmError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`LLM API error ${status}: ${body.slice(0, 300)}`);
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
  const baseUrl = process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = options?.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error("LLM_API_KEY is required (set in .env)");
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options?.temperature ?? 0.7,
  };
  if (options?.maxTokens) {
    body.max_tokens = options.maxTokens;
  }
  if (options?.json) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LlmError(res.status, text);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
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

  return {
    content: choice.message?.content ?? "",
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
    model: data.model ?? model,
  };
}
