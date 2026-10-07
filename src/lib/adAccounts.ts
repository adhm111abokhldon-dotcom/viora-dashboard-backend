/**
 * Business account directory.
 *
 * Maps a Windsor ad-account id to the business account it belongs to, so the
 * dashboard can speak in "Viora", "Trendora — Facebook" and
 * "Trendora — Instagram" without ever exposing raw Windsor ids. Resolution
 * happens at READ time - stored documents keep their ids, so adding or
 * renaming an account here needs no data migration.
 *
 * Adding a new advertising account = add one line to the directory.
 * Unknown ids fall back to a store-derived bucket, so spend is never
 * silently invisible or merged into the wrong account - EXCEPT ids listed
 * in IGNORED_ACCOUNT_IDS, which are deliberately excluded everywhere.
 */
export type StoreId = "viora" | "trendora";

export type BusinessAccountKey =
  | "viora"
  | "trendora_facebook"
  | "trendora_instagram"
  /** Fallback bucket for a Trendora ad account that is not in the directory. */
  | "trendora_other";

/** The three known business accounts, in display order. */
export const BUSINESS_ACCOUNT_KEYS = [
  "viora",
  "trendora_facebook",
  "trendora_instagram",
] as const satisfies readonly BusinessAccountKey[];

/** Every bucket in display order (the fallback bucket appears only if used). */
export const ALL_ACCOUNT_KEYS: readonly BusinessAccountKey[] = [
  ...BUSINESS_ACCOUNT_KEYS,
  "trendora_other",
];

type DirectoryEntry = {
  store: StoreId;
  account: BusinessAccountKey;
};

/**
 * Windsor ad-account id -> business account.
 *
 * Verified against the LIVE Windsor connections:
 *   - Viora connection    -> "Viora Viora"  (1825291261966849, ACTIVE)
 *   - Trendora connection -> "بداية نهاية"    (4405257269697508, ACTIVE)
 *     = Trendora Facebook
 *
 * The Trendora connection also reports the DISABLED "ADHM" account
 * (1783521163010511). ADHM is NOT the Instagram account - it is a wrong /
 * invalid account for this business and is listed in IGNORED_ACCOUNT_IDS so
 * it can never be imported, displayed, or counted anywhere.
 *
 * The REAL Trendora Instagram advertising account has not been returned by
 * Windsor yet. When it appears, add its id here with account:
 * "trendora_instagram". Never add ADHM.
 */
const ACCOUNT_DIRECTORY: Record<string, DirectoryEntry> = {
  "1825291261966849": { store: "viora", account: "viora" },
  "4405257269697508": { store: "trendora", account: "trendora_facebook" },
};

/**
 * Ad-account ids that must be excluded from EVERY part of the system:
 * not imported by sync, not previewed, never mapped, never counted in
 * Advertising totals or Reports, never a fallback bucket.
 *
 * Deterministic id-based exclusion - never depends on Windsor response order.
 */
export const IGNORED_ACCOUNT_IDS: readonly string[] = [
  // Windsor: "ADHM", Trendora connection, DISABLED.
  "1783521163010511",
];

/** True when an ad account is explicitly ignored (e.g. ADHM). */
export function isIgnoredAccount(
  accountId: string | null | undefined,
): boolean {
  const id = (accountId ?? "").trim();

  return id !== "" && IGNORED_ACCOUNT_IDS.includes(id);
}

/**
 * Resolve the business account for one stored Windsor row.
 *
 * - Ignored id (ADHM) -> null: the caller must SKIP the row entirely.
 * - Known id  -> its directory entry (the directory is authoritative).
 * - Viora     -> always "viora": that store has exactly ONE ad account.
 * - Trendora  -> "trendora_other" so an unmapped account stays visible
 *                instead of being merged into Facebook or Instagram.
 *
 * Returns null ONLY for ignored accounts; every other input resolves to a
 * real bucket, so spend is never silently invisible.
 */
export function resolveBusinessAccount(
  store: string | null | undefined,
  accountId: string | null | undefined,
): BusinessAccountKey | null {
  if (isIgnoredAccount(accountId)) return null;

  const hit = ACCOUNT_DIRECTORY[(accountId ?? "").trim()];

  if (hit) return hit.account;

  return store === "viora" ? "viora" : "trendora_other";
}

/** Every trendora directory id plus the ignored ids, for `$nin` filters. */
const EXCLUDED_TRENDORA_IDS = [
  ...Object.entries(ACCOUNT_DIRECTORY)
    .filter(([, entry]) => entry.store === "trendora")
    .map(([id]) => id),
  ...IGNORED_ACCOUNT_IDS,
];

/**
 * Mongo filter selecting every Windsor row that resolves to `key`.
 * Kept next to the resolver so the two can never drift apart.
 */
export function accountFilter(
  key: BusinessAccountKey,
): Record<string, unknown> {
  if (key === "viora") {
    // Any row on the Viora connection resolves to "viora".
    return { source: "windsor", store: "viora" };
  }

  if (key === "trendora_facebook" || key === "trendora_instagram") {
    const ids = Object.entries(ACCOUNT_DIRECTORY)
      .filter(([, entry]) => entry.account === key)
      .map(([id]) => id);

    return { source: "windsor", store: "trendora", accountId: { $in: ids } };
  }

  // trendora_other: on the Trendora connection but neither in the directory
  // nor ignored - ADHM can never land here.
  return {
    source: "windsor",
    store: "trendora",
    accountId: { $nin: EXCLUDED_TRENDORA_IDS },
  };
}

/**
 * Filter that removes ignored accounts (ADHM) from a raw $match, for
 * aggregations that sum ALL advertising rows without resolving buckets
 * (Reports totals, per-period performance, campaign detail lookups).
 * Rows without an accountId (manual expenses) always pass.
 */
export function excludeIgnoredAccountsFilter(): Record<string, unknown> {
  if (IGNORED_ACCOUNT_IDS.length === 0) return {};

  return { accountId: { $nin: [...IGNORED_ACCOUNT_IDS] } };
}

/** Valid values for the `account` query filter on list endpoints. */
export function isAccountKey(value: string): value is BusinessAccountKey {
  return (ALL_ACCOUNT_KEYS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Campaign identity                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Stable campaign identifier: `store|accountId|campaignName`.
 *
 * The same campaign NAME in two different accounts (or two stores) produces
 * two different keys, so Viora and Trendora campaigns can never collide.
 * Mirrors the externalKey convention used by the Windsor sync.
 *
 * The campaign name may itself contain "|": parseCampaignKey splits from the
 * LEFT, so only store and accountId are ever split off.
 */
export function campaignKeyFor(
  store: StoreId,
  accountId: string,
  campaign: string,
): string {
  return [store, accountId || "unknown", campaign].join("|");
}

/** Split a campaign key back into its parts; null when malformed. */
export function parseCampaignKey(
  key: string,
): { store: StoreId; accountId: string; campaign: string } | null {
  const parts = key.split("|");

  if (parts.length < 3) return null;

  const [store, accountId, ...rest] = parts;

  if (store !== "viora" && store !== "trendora") return null;
  if (!accountId) return null;

  const campaign = rest.join("|");

  if (!campaign) return null;

  return { store, accountId, campaign };
}

