// Hindsight REST API client
//   - 不用 SDK(@vectorize-io/hindsight-client),直接 fetch
//   - 理由:减少依赖、只需要 retain/recall/reflect/bank CRUD,不用其他
//   - 如果 future 需要更多 endpoint,再考虑换 SDK

const DEFAULT_BASE_URL = "http://localhost:8888";

export class HindsightError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Hindsight API error ${status}: ${body.slice(0, 200)}`);
  }
}

export interface HindsightDisposition {
  skepticism: number;
  literalism: number;
  empathy: number;
}

export interface HindsightBank {
  bank_id: string;
  name: string;
  mission: string;
  disposition?: HindsightDisposition;
  created_at?: string;
  updated_at?: string;
  fact_count?: number;
}

export type MemoryType = "world" | "experience" | "observation";

export interface HindsightMemory {
  id?: string;
  text: string;
  context?: string;
  type: MemoryType;
  occurred_start?: string;
  occurred_end?: string;
  entities?: string[];
  tags?: string[];
  document_id?: string;
}

export interface RetainResponse {
  id: string;
  [key: string]: unknown;
}

export interface RecallResult {
  id: string;
  text: string;
  score: number;
  [key: string]: unknown;
}

export interface ReflectResponse {
  content: string;
  [key: string]: unknown;
}

export class HindsightClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    // 防止 baseUrl 結尾多 /,跟 path 開頭的 / 拼成 //
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      if (!res.ok) return false;
      const text = await res.text();
      // Hindsight 的 /health 通常回 "ok" 或 JSON,不空就視為 healthy
      return text.length > 0;
    } catch {
      return false;
    }
  }

  async listBanks(): Promise<HindsightBank[]> {
    const res = await this.request("GET", "/v1/default/banks");
    const data: unknown = await res.json();
    if (Array.isArray(data)) return data as HindsightBank[];
    if (data && typeof data === "object" && "banks" in data) {
      const banks = (data as { banks: unknown }).banks;
      if (Array.isArray(banks)) return banks as HindsightBank[];
    }
    return [];
  }

  async createBank(params: {
    bank_id: string;
    name: string;
    mission: string;
    disposition?: HindsightDisposition;
  }): Promise<HindsightBank> {
    const res = await this.request("POST", "/v1/default/banks", params);
    return (await res.json()) as HindsightBank;
  }

  async getBank(bankId: string): Promise<HindsightBank> {
    const res = await this.request(
      "GET",
      `/v1/default/banks/${encodeURIComponent(bankId)}`,
    );
    return (await res.json()) as HindsightBank;
  }

  async deleteBank(bankId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/default/banks/${encodeURIComponent(bankId)}`,
    );
  }

  async retain(bankId: string, memory: HindsightMemory): Promise<RetainResponse> {
    const res = await this.request(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      memory,
    );
    return (await res.json()) as RetainResponse;
  }

  async recall(
    bankId: string,
    query: string,
    options?: { limit?: number; tags?: string[] },
  ): Promise<RecallResult[]> {
    const res = await this.request(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
      {
        query,
        limit: options?.limit ?? 10,
        ...(options?.tags ? { tags: options.tags } : {}),
      },
    );
    const data: unknown = await res.json();
    if (Array.isArray(data)) return data as RecallResult[];
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      const results = obj.results ?? obj.memories;
      if (Array.isArray(results)) return results as RecallResult[];
    }
    return [];
  }

  async reflect(
    bankId: string,
    query: string,
    options?: { tags?: string[] },
  ): Promise<ReflectResponse> {
    const res = await this.request(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/reflect`,
      {
        query,
        ...(options?.tags ? { tags: options.tags } : {}),
      },
    );
    return (await res.json()) as ReflectResponse;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const headers: Record<string, string> = {};
        if (body !== undefined && body !== null) {
          headers["Content-Type"] = "application/json";
        }
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body !== undefined && body !== null
            ? JSON.stringify(body)
            : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 429 || res.status >= 500) {
          const waitMs = attempt >= maxAttempts - 1
            ? 0
            : 1000 * Math.pow(2, attempt);
          await sleep(waitMs);
          attempt++;
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          throw new HindsightError(res.status, text);
        }

        return res;
      } catch (err) {
        clearTimeout(timeout);
        // 網路錯誤或 abort 也 retry
        if (err instanceof HindsightError) throw err;
        if (attempt >= maxAttempts - 1) throw err;
        const waitMs = 1000 * Math.pow(2, attempt);
        await sleep(waitMs);
        attempt++;
      }
    }

    throw new Error(`Hindsight request failed after ${maxAttempts} attempts: ${path}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
