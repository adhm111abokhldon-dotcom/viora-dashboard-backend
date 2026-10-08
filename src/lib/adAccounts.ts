export type StoreId = "viora" | "trendora";

export type BusinessAccountKey =
  | "viora"
  | "trendora_facebook"
  | "trendora_instagram";

export const BUSINESS_ACCOUNT_KEYS = [
  "viora",
  "trendora_facebook",
  "trendora_instagram",
] as const satisfies readonly BusinessAccountKey[];

type DirectoryEntry = {
  store: StoreId;
  account: BusinessAccountKey;
};

let directory: Record<string, DirectoryEntry> | undefined;

function getAccountDirectory(): Record<string, DirectoryEntry> {
  if (directory) return directory;

  directory = {
    "1825291261966849": { store: "viora", account: "viora" },
    "4405257269697508": { store: "trendora", account: "trendora_facebook" },
  };

  const instagramAccountId =
    process.env.WINDSOR_TRENDORA_INSTAGRAM_ACCOUNT_ID?.trim();
  if (instagramAccountId) {
    if (directory[instagramAccountId]) {
      throw new Error(
        "WINDSOR_TRENDORA_INSTAGRAM_ACCOUNT_ID duplicates a mapped advertising account",
      );
    }

    directory[instagramAccountId] = {
      store: "trendora",
      account: "trendora_instagram",
    };
  }

  return directory;
}

export function resolveBusinessAccount(
  store: string | null | undefined,
  accountId: string | null | undefined,
): BusinessAccountKey | null {
  const id = (accountId ?? "").trim();
  if (!id) return null;

  const entry = getAccountDirectory()[id];
  return entry && entry.store === store ? entry.account : null;
}

export function isKnownBusinessAccount(
  store: string | null | undefined,
  accountId: string | null | undefined,
): boolean {
  return resolveBusinessAccount(store, accountId) !== null;
}

export function isBusinessAccountConfigured(
  key: BusinessAccountKey,
): boolean {
  return Object.values(getAccountDirectory()).some(
    (entry) => entry.account === key,
  );
}

export function isAccountKey(value: string): value is BusinessAccountKey {
  return (BUSINESS_ACCOUNT_KEYS as readonly string[]).includes(value);
}

/**
 * Keep manual expenses while excluding every Windsor account not explicitly
 * mapped above. Unknown accounts must never fall into another store's totals.
 */
export function excludeUnmappedWindsorAccountsFilter(): Record<string, unknown> {
  return {
    $nor: [
      {
        source: "windsor",
        accountId: { $nin: Object.keys(getAccountDirectory()) },
      },
    ],
  };
}

export function accountFilter(
  key: BusinessAccountKey,
): Record<string, unknown> {
  const accountIds = Object.entries(getAccountDirectory())
    .filter(([, entry]) => entry.account === key)
    .map(([accountId]) => accountId);

  return {
    source: "windsor",
    accountId: { $in: accountIds },
  };
}

/* -------------------------------------------------------------------------- */
/* Campaign identity                                                          */
/* -------------------------------------------------------------------------- */

/** Stable identity prevents same-named campaigns in different accounts colliding. */
export function campaignKeyFor(
  store: StoreId,
  accountId: string,
  campaign: string,
): string {
  return [store, accountId || "unknown", campaign].join("|");
}

/** Parse the two fixed identity separators; the campaign remainder is opaque. */
export function parseCampaignKey(
  key: string,
): { store: StoreId; accountId: string; campaign: string } | null {
  const firstSeparator = key.indexOf("|");
  const secondSeparator = key.indexOf("|", firstSeparator + 1);
  if (firstSeparator < 1 || secondSeparator < 0) return null;

  const store = key.slice(0, firstSeparator);
  const accountId = key.slice(firstSeparator + 1, secondSeparator);
  if (store !== "viora" && store !== "trendora") return null;
  if (!accountId) return null;

  const campaign = key.slice(secondSeparator + 1);
  if (!campaign) return null;

  return { store, accountId, campaign };
}
