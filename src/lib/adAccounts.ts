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
  campaignId?: string | null,
): string {
  const safeCampaignId =
    campaignId && campaignId.trim() ? campaignId.trim() : null;
  if (safeCampaignId) {
    return [
      store,
      accountId || "unknown",
      `cid:${safeCampaignId}`,
      campaign,
    ].join("|");
  }
  return [store, accountId || "unknown", campaign].join("|");
}

/** Key used by campaign links and catalog entries created before Windsor
 *  started returning stable campaign ids - no `cid:` segment. */
export function legacyCampaignKeyFor(
  store: StoreId,
  accountId: string,
  campaign: string,
): string {
  return campaignKeyFor(store, accountId, campaign);
}

/** Every key variant that may refer to the same campaign: the key itself
 *  plus, for `cid:` keys, the legacy name-only key used before campaign ids
 *  existed. Used when looking up a campaign that was linked under the old
 *  format. */
export function campaignKeyVariants(key: string): string[] {
  const parsed = parseCampaignKey(key);
  if (!parsed || !parsed.campaignId) return [key];
  return [
    key,
    legacyCampaignKeyFor(parsed.store, parsed.accountId, parsed.campaign),
  ];
}

export function parseCampaignKey(
  key: string,
): {
  store: StoreId;
  accountId: string;
  campaignId: string | null;
  campaign: string;
} | null {
  const firstSeparator = key.indexOf("|");
  const secondSeparator = key.indexOf("|", firstSeparator + 1);
  if (firstSeparator < 1 || secondSeparator < 0) return null;

  const store = key.slice(0, firstSeparator);
  const accountId = key.slice(firstSeparator + 1, secondSeparator);
  if (store !== "viora" || !accountId) return null;

  const remainder = key.slice(secondSeparator + 1);
  if (!remainder) return null;

  let campaignId: string | null = null;
  let campaign = remainder;
  const cidMarker = "cid:";
  if (remainder.startsWith(cidMarker)) {
    const markerEnd = remainder.indexOf("|", cidMarker.length);
    campaignId = markerEnd < 0 ? remainder.slice(cidMarker.length) : remainder.slice(cidMarker.length, markerEnd);
    campaign = markerEnd < 0 ? "" : remainder.slice(markerEnd + 1);
    if (!campaignId || !campaign) return null;
  }

  return { store, accountId, campaignId, campaign };
}
