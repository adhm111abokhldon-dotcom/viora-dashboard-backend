/**
 * Read-only Windsor.ai (Meta) connector.
 *
 * Two independent connections, one per store:
 *
 *   WINDSOR_VIORA_API_KEY      -> Viora
 *   WINDSOR_TRENDORA_API_KEY   -> Trendora
 *
 * IMPORTANT: one connection is NOT one advertising account. The Trendora
 * connection returns two ad accounts in a single response (one ACTIVE, one
 * DISABLED). Every row therefore carries its own `accountId`/`accountName`,
 * and the external key includes both, so one account can never overwrite or
 * shadow the other.
 *
 * Keys are read from the backend env only. They are never returned to the
 * client, never logged, and never placed in a URL that leaves the server.
 *
 * Field IDs verified against https://connectors.windsor.ai/facebook/fields
 * (858 fields) rather than guessed:
 *   spend      <- "spend"                                    Amount Spent
 *   clicks     <- "clicks"                                   Clicks
 *   messages   <- "actions_onsite_conversion_messaging_conversation_started_7d"
 *   costPerMsg <- "cost_per_action_type_onsite_conversion_messaging_conversation_started_7d"
 *   currency   <- "currency"                                 Currency (TEXT)
 *   accountId  <- "account_id" / accountName <- "account_name"
 * NOTE: "platform" and "channel" are NOT valid Windsor fields.
 */

const BASE_URL = "https://connectors.windsor.ai/facebook";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Windsor/Meta refuses a start date more than 37 months back. We ask for
 * 36 months so the request is always inside the limit, and then report the
 * period Windsor ACTUALLY returned rather than pretending to have more.
 */
export const WINDSOR_MAX_HISTORY_MONTHS = 36;

/**
 * Windsor can be very slow over a wide window (it times out), so the client
 * walks back from the widest range until one answers. Whatever succeeds is
 * reported as the ACTUAL available period - nothing is invented, and a
 * narrower successful range is reported honestly rather than hidden.
 */
const HISTORY_LADDER_MONTHS = [36, 13, 6] as const;

export type StoreId = "viora" | "trendora";

export const WINDSOR_FIELDS = {
  date: "date",
  campaign: "campaign",
  spend: "spend",
  clicks: "clicks",
  messages: "actions_onsite_conversion_messaging_conversation_started_7d",
  costPerMessage: "cost_per_action_type_onsite_conversion_messaging_conversation_started_7d",
  currency: "currency",
  accountId: "account_id",
  accountName: "account_name",
  // Requesting account_status makes Windsor ALSO return accounts that are
  // disabled / have no activity, so a second ad account is never invisible.
  accountStatus: "account_status",
  campaignEffectiveStatus: "campaign_effective_status",
  campaignConfiguredStatus: "campaign_configured_status",
} as const;

const REQUESTED_FIELDS = Object.values(WINDSOR_FIELDS).join(",");

export type WindsorConnectionId = "viora-windsor" | "trendora-windsor";

type ConnectionConfig = {
  id: WindsorConnectionId;
  store: StoreId;
  /** Key used in the API and shown in the UI. Never the env name. */
  label: string;
  envKeys: string[];
};

/**
 * Exactly two configured connections - no connection-management system.
 * `WINDSOR_API_KEY` is kept as a fallback for the Viora key so an existing
 * environment keeps working while it is renamed to WINDSOR_VIORA_API_KEY.
 */
const CONNECTIONS: ConnectionConfig[] = [
  {
    id: "viora-windsor",
    store: "viora",
    label: "Viora Windsor",
    envKeys: ["WINDSOR_VIORA_API_KEY", "WINDSOR_API_KEY"],
  },
  {
    id: "trendora-windsor",
    store: "trendora",
    label: "Trendora Windsor",
    envKeys: ["WINDSOR_TRENDORA_API_KEY"],
  },
];

export class WindsorError extends Error {
  status: number;
  /** Safe, loggable identifier - never the key itself. */
  connection: WindsorConnectionId;

  constructor(message: string, status = 502, connection?: WindsorConnectionId) {
    super(message);
    this.name = "WindsorError";
    this.status = status;
    this.connection = connection ?? ("viora-windsor" as WindsorConnectionId);
  }
}

/** Reads the key for a connection. Returns null when not configured. */
function readKey(config: ConnectionConfig): string | null {
  for (const name of config.envKeys) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }

  return null;
}

/** Which connections have a key configured (for status display). */
export function configuredConnections() {
  return CONNECTIONS.map((config) => ({
    id: config.id,
    store: config.store,
    label: config.label,
    configured: readKey(config) !== null,
  }));
}

export type WindsorRow = {
  store: StoreId;
  connectionId: WindsorConnectionId;
  accountId: string;
  accountName: string;
  accountStatus: string;
  campaignEffectiveStatus: string | null;
  campaignConfiguredStatus: string | null;
  /** YYYY-MM-DD exactly as Windsor returned it. */
  date: string;
  campaign: string;
  /** Raw spend in the SOURCE currency (AED); never converted here. */
  spend: number;
  clicks: number;
  messages: number;
  costPerMessage: number | null;
  currency: string;
};

/** One ad account discovered inside a connection. */
export type WindsorAccount = {
  store: StoreId;
  connectionId: WindsorConnectionId;
  accountId: string;
  accountName: string;
  accountStatus: string;
  /** Min/max YYYY-MM-DD across the rows actually returned. */
  from: string | null;
  to: string | null;
  rowCount: number;
  sourceSpend: number;
  messages: number;
  clicks: number;
};

/** An ad account Windsor reported, even if it produced no usable rows. */
export type WindsorAccountSighting = {
  accountId: string;
  accountName: string;
  accountStatus: string;
};

export type ConnectionResult = {
  connectionId: WindsorConnectionId;
  store: StoreId;
  label: string;
  rows: WindsorRow[];
  accounts: WindsorAccount[];
  /** Accounts present in the response, including empty/disabled ones. */
  sightings: WindsorAccountSighting[];
  /** Widest history window Windsor actually answered. */
  historyMonths: number;
};

export type WindsorFetchAllResult = {
  connections: ConnectionResult[];
  /** Earliest/latest date across every configured connection. */
  availableFrom: string | null;
  availableTo: string | null;
  /** Connections that failed, so one broken account cannot hide the other. */
  errors: Array<{ connectionId: WindsorConnectionId; message: string }>;
};

/**
 * Windsor may return an empty campaign-day row alongside its populated row.
 * Collapse those rows before previewing or syncing, and reject conflicting
 * populated rows rather than allowing response order to overwrite metrics.
 */
export function deduplicateCampaignDayRows(rows: WindsorRow[]): WindsorRow[] {
  const groups = new Map<string, WindsorRow[]>();

  for (const row of rows) {
    const key = JSON.stringify([
      row.store,
      row.connectionId,
      row.accountId,
      row.date,
      row.campaign,
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const deduplicated: WindsorRow[] = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      deduplicated.push(group[0]!);
      continue;
    }

    const populated = group.filter(
      (row) => row.spend !== 0 || row.clicks !== 0 || row.messages !== 0,
    );
    const candidates = populated.length > 0 ? populated : group;
    const signatures = new Set(
      candidates.map((row) =>
        JSON.stringify([
          row.accountName,
          row.accountStatus,
          row.campaignEffectiveStatus,
          row.campaignConfiguredStatus,
          row.spend,
          row.clicks,
          row.messages,
          row.costPerMessage,
          row.currency,
        ]),
      ),
    );

    if (signatures.size > 1) {
      throw new WindsorError(
        "Windsor returned conflicting rows for the same campaign and day",
        502,
        group[0]!.connectionId,
      );
    }

    deduplicated.push(candidates[0]!);
  }

  return deduplicated;
}

/** Marker for rows with no account id, so keys stay well-formed. */
export const UNKNOWN_ACCOUNT = "unknown";

/**
 * Stable external identity for one Windsor row:
 *   windsor | store | ad-account | date | campaign
 */
export function externalKeyFor(
  store: StoreId,
  accountId: string,
  date: string,
  campaign: string,
): string {
  return ["windsor", store, accountId || UNKNOWN_ACCOUNT, date, campaign].join("|");
}

/**
 * The key format used before the store segment existed:
 *   windsor | ad-account | date | campaign
 *
 * Rows synced with the older key would otherwise be orphaned when the format
 * changed and would be counted TWICE. Sync re-keys them in place (no delete),
 * so the store split is complete and spend is never double counted.
 */
export function legacyExternalKeyFor(
  accountId: string,
  date: string,
  campaign: string,
): string {
  return ["windsor", accountId || UNKNOWN_ACCOUNT, date, campaign].join("|");
}

/** Coerce to a finite number; anything non-numeric becomes 0. */
function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

/** YYYY-MM-DD for `months` before `now`. */
export function earliestQueryableDate(months = WINDSOR_MAX_HISTORY_MONTHS, now = new Date()): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);

  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");

  return `${d.getFullYear()}-${m}-${day}`;
}

export function todayDate(now = new Date()): string {
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");

  return `${now.getFullYear()}-${m}-${day}`;
}

/** Windsor returns either {"data": [...]} or a bare array. */
function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];

  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as Record<string, unknown>[];

    const message = (payload as { error?: unknown }).error;
    if (typeof message === "string" && message) {
      throw new WindsorError(`Windsor rejected the request: ${message}`);
    }
  }

  return [];
}

function normalise(
  raw: Record<string, unknown>[],
  config: ConnectionConfig,
): { rows: WindsorRow[]; currency: string; sightings: WindsorAccountSighting[] } {
  const rows: WindsorRow[] = [];
  const seen = new Map<string, WindsorAccountSighting>();
  let currency = "AED";

  for (const r of raw) {
    /* Record every ad account Windsor mentions BEFORE filtering rows, so an
       account with no usable data (e.g. disabled) is still visible. */
    const rawAccountId =
      typeof r[WINDSOR_FIELDS.accountId] === "string"
        ? (r[WINDSOR_FIELDS.accountId] as string).trim()
        : "";
    const rawAccountName =
      typeof r[WINDSOR_FIELDS.accountName] === "string"
        ? (r[WINDSOR_FIELDS.accountName] as string).trim()
        : "";

    if (rawAccountId && !seen.has(rawAccountId)) {
      seen.set(rawAccountId, {
        accountId: rawAccountId,
        accountName: rawAccountName,
        accountStatus:
          typeof r[WINDSOR_FIELDS.accountStatus] === "string"
            ? (r[WINDSOR_FIELDS.accountStatus] as string).trim()
            : "",
      });
    }

    const date = typeof r.date === "string" ? r.date.trim() : "";
    const campaign = typeof r.campaign === "string" ? r.campaign.trim() : "";

    // A row without a usable date or campaign cannot be identified or
    // de-duplicated, so it is skipped rather than stored.
    if (!date || !campaign) continue;

    if (typeof r.currency === "string" && r.currency.trim()) {
      currency = r.currency.trim();
    }

    const messages = num(r[WINDSOR_FIELDS.messages]);

    rows.push({
      store: config.store,
      connectionId: config.id,
      accountId:
        typeof r[WINDSOR_FIELDS.accountId] === "string"
          ? (r[WINDSOR_FIELDS.accountId] as string).trim()
          : "",
      accountName:
        typeof r[WINDSOR_FIELDS.accountName] === "string"
          ? (r[WINDSOR_FIELDS.accountName] as string).trim()
          : "",
      accountStatus:
        typeof r[WINDSOR_FIELDS.accountStatus] === "string"
          ? (r[WINDSOR_FIELDS.accountStatus] as string).trim()
          : "",
      campaignEffectiveStatus:
        typeof r[WINDSOR_FIELDS.campaignEffectiveStatus] === "string"
          ? (r[WINDSOR_FIELDS.campaignEffectiveStatus] as string).trim()
          : null,
      campaignConfiguredStatus:
        typeof r[WINDSOR_FIELDS.campaignConfiguredStatus] === "string"
          ? (r[WINDSOR_FIELDS.campaignConfiguredStatus] as string).trim()
          : null,
      date,
      campaign,
      spend: num(r[WINDSOR_FIELDS.spend]),
      clicks: num(r[WINDSOR_FIELDS.clicks]),
      messages,
      costPerMessage:
        messages > 0 ? num(r[WINDSOR_FIELDS.costPerMessage]) : null,
      currency,
    });
  }

  return {
    rows: deduplicateCampaignDayRows(rows),
    currency,
    sightings: [...seen.values()],
  };
}

/** Group a connection's rows per ad account, keeping them fully separate. */
function summariseAccounts(
  rows: WindsorRow[],
  config: ConnectionConfig,
): WindsorAccount[] {
  const map = new Map<string, WindsorAccount>();

  for (const row of rows) {
    const key = row.accountId || UNKNOWN_ACCOUNT;

    if (!map.has(key)) {
      map.set(key, {
        store: config.store,
        connectionId: config.id,
        accountId: row.accountId,
        accountName: row.accountName,
        accountStatus: row.accountStatus,
        from: row.date,
        to: row.date,
        rowCount: 0,
        sourceSpend: 0,
        messages: 0,
        clicks: 0,
      });
    }

    const acc = map.get(key)!;
    acc.rowCount += 1;
    acc.sourceSpend += row.spend;
    acc.messages += row.messages;
    acc.clicks += row.clicks;
    if (row.date < acc.from!) acc.from = row.date;
    if (row.date > acc.to!) acc.to = row.date;
  }

  return [...map.values()];
}

async function fetchConnection(config: ConnectionConfig): Promise<ConnectionResult> {
  const apiKey = readKey(config);

  if (!apiKey) {
    throw new WindsorError(
      // Never leak env-var names in a message the UI shows to the owner.
      `${config.label} is not connected yet`,
      503,
      config.id,
    );
  }

  let lastError: WindsorError | null = null;

  // Widest range first; fall back only if Windsor cannot serve it.
  for (const months of HISTORY_LADDER_MONTHS) {
    const url = new URL(BASE_URL);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("fields", REQUESTED_FIELDS);
    url.searchParams.set("date_from", earliestQueryableDate(months));
    url.searchParams.set("date_to", todayDate());

    let response: Response;

    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && error.name === "TimeoutError";

      lastError = new WindsorError(
        timedOut
          ? `${config.label} did not respond in time`
          : `Could not reach ${config.label}`,
        timedOut ? 504 : 502,
        config.id,
      );

      // A timeout may just mean the range was too wide; try a narrower one.
      continue;
    }

    if (!response.ok) {
      lastError = new WindsorError(
        `${config.label} returned an error (HTTP ${response.status})`,
        502,
        config.id,
      );

      // A 4xx range error will not improve by narrowing; give up.
      if (response.status < 500) break;

      continue;
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      lastError = new WindsorError(
        `${config.label} returned an unreadable response`,
        502,
        config.id,
      );

      continue;
    }

    const { rows, sightings } = normalise(extractRows(payload), config);

    return {
      connectionId: config.id,
      store: config.store,
      label: config.label,
      rows,
      accounts: summariseAccounts(rows, config),
      sightings,
      historyMonths: months,
    };
  }

  // The URL holds the key and is deliberately never included.
  throw (
    lastError ??
    new WindsorError(`${config.label} returned no data`, 502, config.id)
  );
}

/**
 * Fetch EVERY configured connection over its FULL available period.
 *
 * One connection failing does not hide the other: failures come back in
 * `errors` instead of throwing.
 */
export async function fetchAllWindsorData(): Promise<WindsorFetchAllResult> {
  const settled = await Promise.all(
    CONNECTIONS.map(async (config) => {
      try {
        return { result: await fetchConnection(config), error: null };
      } catch (error) {
        const message =
          error instanceof WindsorError
            ? error.message
            : "Unexpected Windsor failure";

        return { result: null, error: { connectionId: config.id, message } };
      }
    }),
  );

  const connections: ConnectionResult[] = [];
  const errors: Array<{ connectionId: WindsorConnectionId; message: string }> = [];

  for (const item of settled) {
    if (item.result) connections.push(item.result);
    else if (item.error) errors.push(item.error);
  }

  const allDates = connections.flatMap((c) =>
    c.rows.map((r) => r.date),
  );
  const sortedDates = [...allDates].sort();

  return {
    connections,
    availableFrom: sortedDates[0] ?? null,
    availableTo: sortedDates[sortedDates.length - 1] ?? null,
    errors,
  };
}
