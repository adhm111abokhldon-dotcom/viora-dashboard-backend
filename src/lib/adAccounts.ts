export type StoreId = "viora";
export type BusinessAccountKey = "viora";

export const BUSINESS_ACCOUNT_KEYS = ["viora"] as const;

const VIORA_AD_ACCOUNT_ID = "1825291261966849";

export function resolveBusinessAccount(
  store: string | null | undefined,
  accountId: string | null | undefined,
): BusinessAccountKey | null {
  return store === "viora" && accountId?.trim() === VIORA_AD_ACCOUNT_ID
    ? "viora"
    : null;
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
  return key === "viora";
}

export function isAccountKey(value: string): value is BusinessAccountKey {
  return value === "viora";
}

export function excludeUnmappedWindsorAccountsFilter(): Record<string, unknown> {
  return {
    $nor: [
      {
        source: "windsor",
        $or: [
          { store: { $ne: "viora" } },
          { accountId: { $ne: VIORA_AD_ACCOUNT_ID } },
        ],
      },
    ],
  };
}

export function accountFilter(
  key: BusinessAccountKey,
): Record<string, unknown> {
  return {
    source: "windsor",
    store: "viora",
    accountId: key === "viora" ? VIORA_AD_ACCOUNT_ID : "",
  };
}

/** Stable identity keeps campaign names opaque after the fixed account prefix. */
export function campaignKeyFor(
  store: StoreId,
  accountId: string,
  campaign: string,
): string {
  return [store, accountId || "unknown", campaign].join("|");
}

export function parseCampaignKey(
  key: string,
): { store: StoreId; accountId: string; campaign: string } | null {
  const firstSeparator = key.indexOf("|");
  const secondSeparator = key.indexOf("|", firstSeparator + 1);
  if (firstSeparator < 1 || secondSeparator < 0) return null;

  const store = key.slice(0, firstSeparator);
  const accountId = key.slice(firstSeparator + 1, secondSeparator);
  if (store !== "viora" || !accountId) return null;

  const campaign = key.slice(secondSeparator + 1);
  if (!campaign) return null;

  return { store, accountId, campaign };
}
