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
 * silently invisible or merged into the wrong account.
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
 * Verified against the live Windsor connections:
 *   - Viora connection    -> one account ("Viora Viora")
 *   - Trendora connection -> two accounts ("بداية نهاية" ACTIVE,
 *                            "ADHM" DISABLED) = Facebook + Instagram.
 */
const ACCOUNT_DIRECTORY: Record<string, DirectoryEntry> = {
  "1825291261966849": { store: "viora", account: "viora" },
  "4405257269697508": { store: "trendora", account: "trendora_facebook" },
  "1783521163010511": { store: "trendora", account: "trendora_instagram" },
};

/**
 * Resolve the business account for one stored Windsor row.
 *
 * - Known id  -> its directory entry (the directory is authoritative).
 * - Viora     -> always "viora": that store has exactly ONE ad account.
 * - Trendora  -> "trendora_other" so an unmapped account stays visible
 *                instead of being merged into Facebook or Instagram.
 */
export function resolveBusinessAccount(
  store: string | null | undefined,
  accountId: string | null | undefined,
): BusinessAccountKey {
  const hit = ACCOUNT_DIRECTORY[(accountId ?? "").trim()];

  if (hit) return hit.account;

  return store === "viora" ? "viora" : "trendora_other";
}

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

  const trendoraIds = Object.entries(ACCOUNT_DIRECTORY)
    .filter(([, entry]) => entry.store === "trendora")
    .map(([id]) => id);

  if (key === "trendora_facebook" || key === "trendora_instagram") {
    const ids = Object.entries(ACCOUNT_DIRECTORY)
      .filter(([, entry]) => entry.account === key)
      .map(([id]) => id);

    return { source: "windsor", store: "trendora", accountId: { $in: ids } };
  }

  // trendora_other: on the Trendora connection but NOT in the directory.
  return {
    source: "windsor",
    store: "trendora",
    accountId: { $nin: trendoraIds },
  };
}

/** Valid values for the `account` query filter on list endpoints. */
export function isAccountKey(value: string): value is BusinessAccountKey {
  return (ALL_ACCOUNT_KEYS as readonly string[]).includes(value);
}
