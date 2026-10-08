export type CampaignProviderState = "current" | "historical" | "unknown";
export type CampaignCatalogState =
  | "active"
  | "paused"
  | "historical"
  | "deleted"
  | "unverified"
  | "other";

export function getCampaignProviderState(
  lastSeenAt: Date | null | undefined,
  lastSuccessfulSyncAt: Date | null | undefined,
): CampaignProviderState {
  if (!lastSeenAt || !lastSuccessfulSyncAt) return "unknown";
  return lastSeenAt.getTime() >= lastSuccessfulSyncAt.getTime()
    ? "current"
    : "historical";
}

export function getCampaignCatalogState(
  providerStatus: string | null | undefined,
  providerState: CampaignProviderState,
): CampaignCatalogState {
  if (providerState === "unknown") return "unverified";
  if (providerState === "historical") return "deleted";

  const status = providerStatus?.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!status) return "other";
  if (status === "DELETED" || status === "REMOVED") return "deleted";
  if (
    status === "COMPLETED" ||
    status === "COMPLETE" ||
    status === "ARCHIVED" ||
    status === "FINISHED" ||
    status === "ENDED"
  ) {
    return "historical";
  }
  if (status === "ACTIVE" || status.endsWith("_ACTIVE")) return "active";
  if (
    status === "PAUSED" ||
    status.endsWith("_PAUSED") ||
    status === "INACTIVE" ||
    status === "DISABLED"
  ) {
    return "paused";
  }

  return "other";
}

export type CampaignCatalogStateCounts = Record<CampaignCatalogState, number>;

export function emptyCampaignCatalogStateCounts(): CampaignCatalogStateCounts {
  return {
    active: 0,
    paused: 0,
    historical: 0,
    deleted: 0,
    unverified: 0,
    other: 0,
  };
}
