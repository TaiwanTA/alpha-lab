import { afterEach, describe, expect, test } from "bun:test";

import {
  createTwelveDataClient,
  fetchAdjustedCloseSessions,
  loadTwelveDataConfig,
  type TwelveDataConfig,
} from "../scripts/phase4/twelve-data.ts";

// ---------------------------------------------------------------------------
// Twelve Data client tests — at-or-before semantics + weekend/holiday
// fallback. The brief says "the most recent adjusted close at or before
// the requested date"; previously the client requested start_date equal
// to the lookup date, which filtered FROM that date and produced no
// usable quote on weekends/holidays. The fix uses end_date so the
// returned series is the most recent N rows ending on or before the
// requested date, allowing `pickAdjustedClose` to walk back to the
// prior trading session.
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

interface CapturedRequest {
  url: string;
}

function stubFetchJson(
  responder: (url: string) => unknown,
): { captured: CapturedRequest[]; restore: () => void } {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      input instanceof Request ? input.url : String(input);
    captured.push({ url });
    return new Response(JSON.stringify(responder(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = ORIGINAL_FETCH;
    },
  };
}

const BASE_CONFIG: TwelveDataConfig = {
  baseUrl: "https://api.twelvedata.com",
  apiKey: "test-key",
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("twelve-data fetchAdjustedClose — at-or-before semantics", () => {
  test("uses end_date=date (not start_date) so the series ends at or before the requested date", async () => {
    const { captured, restore } = stubFetchJson(() => ({
      meta: { symbol: "AAPL", interval: "1day" },
      values: [{ datetime: "2026-07-15", close: "195.42" }],
      status: "ok",
    }));
    try {
      const client = createTwelveDataClient(BASE_CONFIG);
      await client.fetchAdjustedClose("AAPL", "2026-07-15");
      expect(captured).toHaveLength(1);
      const u = new URL(captured[0]?.url ?? "");
      expect(u.searchParams.get("end_date")).toBe("2026-07-15");
      expect(u.searchParams.get("start_date")).toBeNull();
      expect(u.searchParams.get("interval")).toBe("1day");
      expect(u.searchParams.get("adjust")).toBe("all");
      expect(u.searchParams.get("apikey")).toBe("test-key");
    } finally {
      restore();
    }
  });

  test("falls back to the prior trading session when the requested date is a weekend", async () => {
    // Twelve Data returns values newest-first. With end_date=Saturday
    // 2026-07-11 (weekend), the provider returns no Saturday/Sunday
    // rows; we want the most recent close on or before that date,
    // which is Friday 2026-07-10.
    const { captured, restore } = stubFetchJson(() => ({
      meta: { symbol: "AAPL", interval: "1day" },
      values: [
        { datetime: "2026-07-13", close: "196.10" },
        { datetime: "2026-07-10", close: "195.42" },
        { datetime: "2026-07-09", close: "194.80" },
      ],
      status: "ok",
    }));
    try {
      const client = createTwelveDataClient(BASE_CONFIG);
      const quote = await client.fetchAdjustedClose("AAPL", "2026-07-11");
      // The series includes 2026-07-13 (Monday) and 2026-07-10 (Friday).
      // The client must NOT pick 2026-07-13 because that date is AFTER
      // the lookup date; it should fall back to 2026-07-10.
      expect(quote.date).toBe("2026-07-10");
      expect(quote.adjustedClose).toBe(195.42);
      expect(captured).toHaveLength(1);
      const u = new URL(captured[0]?.url ?? "");
      expect(u.searchParams.get("end_date")).toBe("2026-07-11");
    } finally {
      restore();
    }
  });

  test("falls back to the prior trading session for a holiday lookup", async () => {
    // 2026-07-04 is US Independence Day (Saturday in 2026, but
    // illustrative). The provider returns the nearest available close
    // on or before 2026-07-03.
    const { restore } = stubFetchJson(() => ({
      meta: { symbol: "AAPL", interval: "1day" },
      values: [
        { datetime: "2026-07-03", close: "192.10" },
        { datetime: "2026-07-02", close: "191.50" },
      ],
      status: "ok",
    }));
    try {
      const client = createTwelveDataClient(BASE_CONFIG);
      const quote = await client.fetchAdjustedClose("AAPL", "2026-07-04");
      expect(quote.date).toBe("2026-07-03");
      expect(quote.adjustedClose).toBe(192.1);
    } finally {
      restore();
    }
  });

  test("throws when no series value is at or before the requested date", async () => {
    const { restore } = stubFetchJson(() => ({
      meta: { symbol: "AAPL", interval: "1day" },
      values: [{ datetime: "2026-07-20", close: "200.00" }],
      status: "ok",
    }));
    try {
      const client = createTwelveDataClient(BASE_CONFIG);
      await expect(
        client.fetchAdjustedClose("AAPL", "2026-07-15"),
      ).rejects.toThrow(/no finite positive adjusted close/);
    } finally {
      restore();
    }
  });

  test("throws when the only row is not a finite positive close", async () => {
    const { restore } = stubFetchJson(() => ({
      meta: { symbol: "AAPL", interval: "1day" },
      values: [
        { datetime: "2026-07-15", close: "0" },
        { datetime: "2026-07-14", close: "not-a-number" },
      ],
      status: "ok",
    }));
    try {
      const client = createTwelveDataClient(BASE_CONFIG);
      await expect(
        client.fetchAdjustedClose("AAPL", "2026-07-15"),
      ).rejects.toThrow(/no finite positive/);
    } finally {
      restore();
    }
  });

  test("surfaces provider status=error responses", async () => {
    const { restore } = stubFetchJson(() => ({
      status: "error",
      message: "API key invalid",
    }));
    try {
      const client = createTwelveDataClient(BASE_CONFIG);
      await expect(
        client.fetchAdjustedClose("AAPL", "2026-07-15"),
      ).rejects.toThrow(/API key invalid/);
    } finally {
      restore();
    }
  });

  test("rejects non-YYYY-MM-DD date format", async () => {
    const client = createTwelveDataClient(BASE_CONFIG);
    await expect(
      client.fetchAdjustedClose("AAPL", "2026/07/15"),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });


  test("returns only actual finite positive sessions in ascending order", async () => {
    const { captured, restore } = stubFetchJson(() => ({
      meta: { symbol: "AAPL", interval: "1day" },
      values: [
        { datetime: "2026-07-17", close: "197.00" },
        { datetime: "2026-07-15", close: "195.00" },
        { datetime: "2026-07-16", close: "0" },
      ],
      status: "ok",
    }));
    try {
      const result = await fetchAdjustedCloseSessions(BASE_CONFIG, "AAPL", "2026-07-15");
      expect(result).toEqual([
        { date: "2026-07-15", adjustedClose: 195 },
        { date: "2026-07-17", adjustedClose: 197 },
      ]);
      const url = new URL(captured[0]?.url ?? "");
      expect(url.searchParams.get("start_date")).toBe("2026-07-15");
      expect(url.searchParams.get("order")).toBe("ASC");
      expect(url.searchParams.get("adjust")).toBe("all");
    } finally {
      restore();
    }
  });

  test("classifies a permanent symbol error as terminal unavailable price", async () => {
    const { restore } = stubFetchJson(() => ({
      status: "error",
      code: 400,
      message: "symbol not found or delisted",
    }));
    try {
      await expect(
        fetchAdjustedCloseSessions(BASE_CONFIG, "DELISTED", "2026-07-15"),
      ).rejects.toThrow(/^terminal unavailable price:/);
    } finally {
      restore();
    }
  });

  test("does not classify date-range no-data as terminal", async () => {
    const { restore } = stubFetchJson(() => ({
      status: "error",
      code: 400,
      message: "no data for the requested date range",
    }));
    try {
      await expect(
        fetchAdjustedCloseSessions(BASE_CONFIG, "AAPL", "2026-07-15"),
      ).rejects.toThrow(/^twelve-data provider error:/);
    } finally {
      restore();
    }
  });
  test("loadTwelveDataConfig throws when TWELVE_DATA_API_KEY is missing", () => {
    expect(() => loadTwelveDataConfig({})).toThrow(/TWELVE_DATA_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — every fetch must carry a finite-timeout signal so a
// hung provider cannot strand a research run. The production code
// uses AbortSignal.timeout(120_000) on the fetch init.
// ---------------------------------------------------------------------------

describe("twelve-data fetch — abort signal", () => {
  test("fetchAdjustedClose fetch carries an AbortSignal", async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | null = null;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const signal: AbortSignal | null = (init?.signal ?? null) as AbortSignal | null;
      capturedSignal = signal;
      return new Response(JSON.stringify({
        meta: { symbol: "AAPL", interval: "1day" },
        values: [{ datetime: "2026-07-15", close: "195.42" }],
        status: "ok",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const client = createTwelveDataClient(BASE_CONFIG);
      await client.fetchAdjustedClose("AAPL", "2026-07-15");
      const captured = capturedSignal as AbortSignal | null;
      expect(captured).toBeInstanceOf(AbortSignal);
      expect((captured as AbortSignal | undefined)?.aborted ?? null).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});