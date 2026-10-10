import type { Types } from "mongoose";
import AdvertisingExpense from "../models/AdvertisingExpense.js";
import Product from "../models/Product.js";
import {
  campaignKeyFor,
  excludeUnmappedWindsorAccountsFilter,
  type StoreId,
} from "./adAccounts.js";
import {
  createCampaignAllocationSnapshot,
  type CampaignAllocationSnapshot,
} from "./campaignAllocation.js";

export type CampaignAllocationReference = {
  key: string;
  store: StoreId;
  accountId: string;
  campaign: string;
};

type ExpenseRow = {
  _id: Types.ObjectId;
  amount: number;
  store?: StoreId;
  accountId?: string;
  campaign?: string;
};

type ProductRow = {
  _id: { toString(): string };
  name: string;
  campaigns: CampaignAllocationReference[];
};

/**
 * Capture unsnapshotted Windsor spend against the currently persisted links.
 * Callers that remove or replace links must capture the old state first;
 * newly added links are captured only after they are persisted.
 */
export async function captureMissingCampaignAllocations(options?: {
  connectionIds?: string[];
  campaigns?: CampaignAllocationReference[];
}): Promise<number> {
  if (options?.campaigns && options.campaigns.length === 0) return 0;

  const match: Record<string, unknown> = {
    source: "windsor",
    allocationSnapshot: { $exists: false },
    campaign: { $type: "string", $ne: "" },
    ...excludeUnmappedWindsorAccountsFilter(),
  };
  if (options?.connectionIds) {
    if (options.connectionIds.length === 0) return 0;
    match.connectionId = { $in: options.connectionIds };
  }
  if (options?.campaigns) {
    match.$or = options.campaigns.map((campaign) => ({
      store: campaign.store,
      accountId: campaign.accountId,
      campaign: campaign.campaign,
    }));
  }

  const expenses = await AdvertisingExpense.find(match)
    .select("_id amount store accountId campaign")
    .lean<ExpenseRow[]>();
  if (expenses.length === 0) return 0;

  const keys = expenses.flatMap((expense) =>
    expense.store && expense.accountId && expense.campaign
      ? [campaignKeyFor(expense.store, expense.accountId, expense.campaign)]
      : [],
  );
  const products = await Product.find({ "campaigns.key": { $in: keys } })
    .select("_id name campaigns")
    .lean<ProductRow[]>();
  const productsByCampaign = new Map<
    string,
    Array<{ productId: string; productName: string }>
  >();

  for (const product of products) {
    const productId = product._id.toString();
    for (const campaign of product.campaigns ?? []) {
      const linked = productsByCampaign.get(campaign.key) ?? [];
      linked.push({ productId, productName: product.name });
      productsByCampaign.set(campaign.key, linked);
    }
  }

  const operations = expenses.flatMap((expense) => {
    if (!expense.store || !expense.accountId || !expense.campaign) return [];
    const key = campaignKeyFor(
      expense.store,
      expense.accountId,
      expense.campaign,
    );
    const snapshot: CampaignAllocationSnapshot =
      createCampaignAllocationSnapshot(
        expense.amount,
        productsByCampaign.get(key) ?? [],
      );
    return [
      {
        updateOne: {
          filter: {
            _id: expense._id,
            allocationSnapshot: { $exists: false },
          },
          update: { $set: { allocationSnapshot: snapshot } },
        },
      },
    ];
  });

  if (operations.length > 0) {
    await AdvertisingExpense.bulkWrite(operations);
  }
  return operations.length;
}
