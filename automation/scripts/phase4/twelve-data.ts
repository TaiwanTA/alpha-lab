// automation/scripts/phase4/twelve-data.ts
//
// Fail-closed Twelve Data client. One endpoint only:
//
//   GET /time_series?symbol=...&interval=1day&adjust=all&apikey=...
//
// The brief requires:
//   - daily series (`interval=1day`, `adjust=all`)
//   - keep only finite, positive adjusted closes
//   - retain provider / request metadata
//   - throw on any provider error rather than silently returning
//     an empty series
//
// `TwelveDataConfig` is the resolved environment shape;
// `TwelveDataClient` is the public surface the agent toolkit calls.

export interface TwelveDataConfig {
  baseUrl: string;
  apiKey: string;
}

export interface AdjustedCloseQuote {
  ticker: string;
  date: string; // YYYY-MM-DD
  adjustedClose: number;
  provider: "twelve-data";
  requestedInterval: "1day";
  requestedAdjust: "all";
}

export interface AdjustedCloseSession {
  date: string;
  adjustedClose: number;
}

export interface TwelveDataClient {
  fetchAdjustedClose(
    ticker: string,
    date: string, // YYYY-MM-DD
  ): Promise<AdjustedCloseQuote>;
  fetchAdjustedCloseSessions?(
    ticker: string,
    startDate: string,
  ): Promise<AdjustedCloseSession[]>;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/** Resolve Twelve Data config from process env. Throws when the
 *  API key is missing — fail-closed. */
export function loadTwelveDataConfig(
  env: Record<string, string | undefined> = process.env,
): TwelveDataConfig {
  const apiKey = env.TWELVE_DATA_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("TWELVE_DATA_API_KEY is required");
  }
  const rawBase = env.TWELVE_DATA_BASE_URL?.trim();
  const baseUrl =
    rawBase && rawBase.length > 0
      ? rawBase.replace(/\/+$/, "")
      : "https://api.twelvedata.com";
  return { baseUrl, apiKey };
}

// ---------------------------------------------------------------------------
// Response parsing — strict, fail-closed on any malformed shape.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RawTimeSeriesValues {
  datetime: string;
  close: string;
}

function parseTimeSeriesValues(raw: unknown): RawTimeSeriesValues[] {
  if (!isRecord(raw)) {
    throw new Error("twelve-data: response is not a JSON object");
  }
  const values = raw.values;
  if (!Array.isArray(values)) {
    throw new Error("twelve-data: response is missing array 'values'");
  }
  return values.map((value, idx) => {
    if (!isRecord(value)) {
      throw new Error(
        `twelve-data: values[${idx}] is not a JSON object`,
      );
    }
    const datetime = value.datetime;
    const close = value.close;
    if (typeof datetime !== "string" || datetime.length === 0) {
      throw new Error(
        `twelve-data: values[${idx}].datetime must be a non-empty string`,
      );
    }
    if (typeof close !== "string") {
      throw new Error(
        `twelve-data: values[${idx}].close must be a string`,
      );
    }
    return { datetime, close };
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const REQUESTED_INTERVAL = "1day" as const;
const REQUESTED_ADJUST = "all" as const;

async function twelveDataRequest(
  config: TwelveDataConfig,
  queryParams: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${config.baseUrl}/time_series`);
  for (const [k, v] of Object.entries(queryParams)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("interval", REQUESTED_INTERVAL);
  url.searchParams.set("adjust", REQUESTED_ADJUST);
  url.searchParams.set("apikey", config.apiKey);
  url.searchParams.set("format", "JSON");

  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `twelve-data failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    throw new Error(
      `twelve-data failed: response is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error("twelve-data failed: response is not a JSON object");
  }
  if (raw.status === "error") {
    const message =
      typeof raw.message === "string" ? raw.message : "unknown provider error";
    const code = typeof raw.code === "number" ? raw.code : null;
    if (code === 400 && /invalid symbol|symbol (?:not found|has been delisted)|delisted symbol/i.test(message)) {
      throw new Error(`terminal unavailable price: ${message}`);
    }
    throw new Error(`twelve-data provider error: ${message}`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Pick the most recent series value at or before the requested date
 *  whose adjusted close is a finite positive number. Throws when no
 *  such value exists rather than returning a sentinel. */
function pickAdjustedClose(
  rawValues: RawTimeSeriesValues[],
  date: string,
): RawTimeSeriesValues {
  // Twelve Data returns values newest-first. Walk them in order and
  // pick the first whose date is <= the requested date and whose close
  // is a finite positive number.
  for (const row of rawValues) {
    if (row.datetime > date) continue;
    const parsed = Number(row.close);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return row;
  }
  throw new Error(
    `twelve-data: no finite positive adjusted close at or before ${date}`,
  );
}

export function createTwelveDataClient(
  config: TwelveDataConfig,
): TwelveDataClient {
  return {
    async fetchAdjustedClose(ticker, date) {
      const normalizedTicker = ticker.trim().toUpperCase();
      if (normalizedTicker.length === 0) {
        throw new Error("twelve-data: ticker must be a non-empty string");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(
          "twelve-data: date must be in YYYY-MM-DD format",
        );
      }
      // Use end_date (not start_date) so the returned series is the
      // most recent N rows ending on or before the requested date.
      // start_date would return only rows on or after the requested
      // date, so a weekend or holiday lookup against `date` would
      // produce no usable quote — `pickAdjustedClose` walks the
      // series newest-first and would then throw with no fallback.
      const raw = await twelveDataRequest(config, {
        symbol: normalizedTicker,
        end_date: date,
        outputsize: "5000",
      });
      const values = parseTimeSeriesValues(raw);
      if (values.length === 0) {
        throw new Error(
          `twelve-data: empty series for ${normalizedTicker}`,
        );
      }
      const picked = pickAdjustedClose(values, date);
      const adjustedClose = Number(picked.close);
      if (!Number.isFinite(adjustedClose) || adjustedClose <= 0) {
        // Defensive: pickAdjustedClose already enforced this, but
        // the constraint is part of the public contract — recheck
        // before constructing the response.
        throw new Error(
          `twelve-data: picked close for ${normalizedTicker} at ${picked.datetime} is not a finite positive number`,
        );
      }
      return {
        ticker: normalizedTicker,
        date: picked.datetime,
        adjustedClose,
        provider: "twelve-data",
        requestedInterval: REQUESTED_INTERVAL,
        requestedAdjust: REQUESTED_ADJUST,
      };
    },
    fetchAdjustedCloseSessions(ticker, startDate) {
      return fetchAdjustedCloseSessions(config, ticker, startDate);
    },
  };
}

export async function fetchAdjustedCloseSessions(
  config: TwelveDataConfig,
  ticker: string,
  startDate: string,
): Promise<AdjustedCloseSession[]> {
  const normalizedTicker = ticker.trim().toUpperCase();
  if (normalizedTicker.length === 0) {
    throw new Error("twelve-data: ticker must be a non-empty string");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error("twelve-data: start date must be in YYYY-MM-DD format");
  }

  const raw = await twelveDataRequest(config, {
    symbol: normalizedTicker,
    start_date: startDate,
    outputsize: "5000",
    order: "ASC",
  });
  const values = parseTimeSeriesValues(raw);
  const byDate = new Map<string, number>();
  for (const row of values) {
    if (row.datetime < startDate) continue;
    const adjustedClose = Number(row.close);
    if (!Number.isFinite(adjustedClose) || adjustedClose <= 0) continue;
    byDate.set(row.datetime, adjustedClose);
  }

  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, adjustedClose]) => ({ date, adjustedClose }));
}