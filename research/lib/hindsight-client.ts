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

export interface HindsightBank {
  bank_id: string;
  name: string;
  mission: string;
  disposition?: { skepticism: number; literalism: number; empathy: number };
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
  constructor(
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listBanks(): Promise<HindsightBank[]> {
    const res = await this.request("GET", "/v1/default/banks");
    const data = (await res.json()) as unknown;
    // API 可能回 array 或 { banks: [...] }
    if (Array.isArray(data)) return data as HindsightBank[];
    if (data && typeof data === "object" && "banks" in data) {
      return ((data as { banks: HindsightBank[] }).banks ?? []) as HindsightBank[];
    }
    return [];
  }

  async createBank(params: {
    bank_id: string;
    name: string;
    mission: string;
    disposition?: { skepticism: number; literalism: number; empathy: number };
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
    const data = (await res.json()) as unknown;
    if (Array.isArray(data)) return data as RecallResult[];
    if (data && typeof data === "object") {
      const obj = data as { results?: RecallResult[]; memories?: RecallResult[] };
      if (obj.results) return obj.results;
      if (obj.memories) return obj.memories;
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
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new HindsightError(res.status, text);
    }

    return res;
  }
}
