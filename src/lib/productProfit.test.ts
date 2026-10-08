import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateEvenly,
  createCampaignAllocationSnapshot,
  revalueCampaignAllocationSnapshot,
} from "./campaignAllocation.js";
import { calculateProductProfit } from "./productProfit.js";
import {
  emptyCampaignCatalogStateCounts,
  getCampaignCatalogState,
  getCampaignProviderState,
} from "./campaignState.js";
import {
  campaignKeyFor,
  isKnownBusinessAccount,
  parseCampaignKey,
  resolveBusinessAccount,
} from "./adAccounts.js";
import {
  campaignLinkSchema,
  createProductSchema,
} from "../schemas/productSchemas.js";
import AdvertisingExpense from "../models/AdvertisingExpense.js";

test("campaign allocation reconciles exact cents for one, two, and three products", () => {
  assert.deepEqual(allocateEvenly(100, 1), [100]);
  assert.deepEqual(allocateEvenly(100, 2), [50, 50]);
  assert.deepEqual(allocateEvenly(100, 3), [33.33, 33.33, 33.34]);
  assert.equal(allocateEvenly(100, 0).length, 0);
  assert.equal(
    allocateEvenly(100, 3).reduce((sum, amount) => sum + amount, 0),
    100,
  );
});

test("campaign allocation snapshots reconcile and leave unlinked spend unallocated", () => {
  const one = createCampaignAllocationSnapshot(30, [
    { productId: "1", productName: "One" },
  ]);
  assert.equal(one.products[0]?.amount, 30);
  assert.equal(one.allocatedSpend, 30);
  assert.equal(one.unallocatedSpend, 0);

  const two = createCampaignAllocationSnapshot(30, [
    { productId: "2", productName: "Two" },
    { productId: "1", productName: "One" },
  ]);
  assert.deepEqual(two.products.map((product) => product.amount), [15, 15]);
  assert.equal(two.allocatedSpend, 30);

  const three = createCampaignAllocationSnapshot(100, [
    { productId: "3", productName: "Three" },
    { productId: "2", productName: "Two" },
    { productId: "1", productName: "One" },
  ]);
  assert.deepEqual(three.products.map((product) => product.amount), [
    33.33, 33.33, 33.34,
  ]);
  assert.equal(
    three.products.reduce((sum, product) => sum + product.amount, 0),
    100,
  );

  const unallocated = createCampaignAllocationSnapshot(17.42, []);
  assert.equal(unallocated.allocatedSpend, 0);
  assert.equal(unallocated.unallocatedSpend, 17.42);
});

test("shared products accumulate campaign allocations without duplicate spend", () => {
  const campaignA = createCampaignAllocationSnapshot(30, [
    { productId: "p1", productName: "Product 1" },
    { productId: "p2", productName: "Product 2" },
  ]);
  const campaignB = createCampaignAllocationSnapshot(20, [
    { productId: "p1", productName: "Product 1" },
  ]);
  const productOne = round2ForTest(
    campaignA.products.find((product) => product.productId === "p1")!.amount +
      campaignB.products.find((product) => product.productId === "p1")!.amount,
  );
  const productTwo = campaignA.products.find(
    (product) => product.productId === "p2",
  )!.amount;

  assert.equal(productOne, 35);
  assert.equal(productTwo, 15);
  assert.equal(campaignA.campaignSpend + campaignB.campaignSpend, 50);
  assert.equal(productOne + productTwo, 50);
});

test("historical snapshots retain the campaign's product set and names", () => {
  const capturedAt = new Date("2026-01-01T00:00:00.000Z");
  const january = createCampaignAllocationSnapshot(
    100,
    [
      { productId: "p1", productName: "Original name" },
      { productId: "p2", productName: "Second product" },
    ],
    capturedAt,
  );
  const february = createCampaignAllocationSnapshot(40, [
    { productId: "p1", productName: "Renamed product" },
  ]);

  assert.deepEqual(
    january.products.map(({ productId, productName, amount }) => ({
      productId,
      productName,
      amount,
    })),
    [
      { productId: "p1", productName: "Original name", amount: 50 },
      { productId: "p2", productName: "Second product", amount: 50 },
    ],
  );
  assert.deepEqual(
    february.products.map(({ productId, amount }) => ({ productId, amount })),
    [{ productId: "p1", amount: 40 }],
  );
  assert.equal(january.products[1]?.productName, "Second product");
  assert.equal(january.capturedAt, capturedAt);
});

test("provider spend corrections preserve snapshot membership and exact cents", () => {
  const original = createCampaignAllocationSnapshot(100, [
    { productId: "p1", productName: "One" },
    { productId: "p2", productName: "Two" },
    { productId: "p3", productName: "Three" },
  ]);
  const corrected = revalueCampaignAllocationSnapshot(100.01, original);

  assert.deepEqual(
    corrected.products.map((product) => product.amount),
    [33.33, 33.34, 33.34],
  );
  assert.equal(
    corrected.products.reduce((sum, product) => sum + product.amount, 0),
    corrected.campaignSpend,
  );
  assert.deepEqual(
    corrected.products.map((product) => product.productName),
    ["One", "Two", "Three"],
  );
  assert.equal(corrected.capturedAt, original.capturedAt);
});

test("provider corrections revalue persisted Mongoose snapshot products", () => {
  const expense = new AdvertisingExpense({
    date: new Date("2026-10-08T00:00:00.000Z"),
    amount: 1.44,
    platform: "Meta",
    allocationSnapshot: createCampaignAllocationSnapshot(1.44, [
      { productId: "p1", productName: "One" },
    ]),
  });
  const corrected = revalueCampaignAllocationSnapshot(
    1.62,
    expense.allocationSnapshot!,
  );

  assert.deepEqual(corrected.products, [
    {
      productId: "p1",
      productName: "One",
      amount: 1.62,
      shareIndex: 0,
      shareCount: 1,
    },
  ]);
  assert.equal(corrected.allocatedSpend, 1.62);
});

test("product profitability handles profit, loss, break-even, and no-sales states", () => {
  assert.deepEqual(calculateProductProfit(100, 40, 10, 20, 1), {
    beforeAdsProfit: 50,
    netProfit: 30,
    marginPercent: 30,
    state: "profitable",
  });
  assert.equal(calculateProductProfit(100, 50, 10, 50, 1).state, "loss");
  assert.equal(calculateProductProfit(100, 50, 10, 39.99, 1).state, "breakEven");
  assert.equal(calculateProductProfit(0, 0, 0, 0, 0).state, "noSales");
  assert.equal(calculateProductProfit(0, 0, 0, 10, 0).netProfit, -10);
  assert.equal(calculateProductProfit(0, 0, 0, 10, 0).marginPercent, 0);
});

test("campaign identities remain distinct and safely parse delimiters in names", () => {
  const key = campaignKeyFor("trendora", "account-2", "October | Beauty");
  assert.deepEqual(parseCampaignKey(key), {
    store: "trendora",
    accountId: "account-2",
    campaign: "October | Beauty",
  });

  test("campaign identities survive Arabic and URL-sensitive campaign names", () => {
    const campaign = "عرض / خصم?10% #1 | Winter";
    const key = campaignKeyFor("trendora", "account-2", campaign);
    assert.deepEqual(parseCampaignKey(key), {
      store: "trendora",
      accountId: "account-2",
      campaign,
    });
    assert.equal(decodeURIComponent(encodeURIComponent(key)), key);
  });
  assert.notEqual(
    campaignKeyFor("viora", "account-2", "October | Beauty"),
    key,
  );
});

test("provider status distinguishes verified, historical, and unverified data", () => {
  const completedSync = new Date("2026-10-08T00:00:00.000Z");
  assert.equal(
    getCampaignProviderState(completedSync, completedSync),
    "current",
  );
  assert.equal(
    getCampaignProviderState(new Date("2026-10-07T00:00:00.000Z"), completedSync),
    "historical",
  );
  assert.equal(getCampaignProviderState(undefined, completedSync), "unknown");
  assert.equal(getCampaignProviderState(completedSync, undefined), "unknown");
});

test("campaign catalog exposes active, paused, completed, deleted and unverified states", () => {
  const latestSync = new Date("2026-10-08T00:00:00.000Z");
  const count = emptyCampaignCatalogStateCounts();
  const fixtures = [
    { status: "ACTIVE", lastSeen: latestSync, expected: "active" },
    { status: "PAUSED", lastSeen: latestSync, expected: "paused" },
    { status: "INACTIVE", lastSeen: latestSync, expected: "paused" },
    { status: "COMPLETED", lastSeen: latestSync, expected: "historical" },
    { status: "ARCHIVED", lastSeen: latestSync, expected: "historical" },
    {
      status: "ACTIVE",
      lastSeen: new Date("2026-10-07T00:00:00.000Z"),
      expected: "deleted",
    },
    { status: "ACTIVE", lastSeen: undefined, expected: "unverified" },
    { status: null, lastSeen: latestSync, expected: "other" },
  ] as const;

  for (const fixture of fixtures) {
    const providerState = getCampaignProviderState(
      fixture.lastSeen,
      latestSync,
    );
    const catalogState = getCampaignCatalogState(
      fixture.status,
      providerState,
    );
    assert.equal(catalogState, fixture.expected);
    count[catalogState] += 1;
  }

  assert.deepEqual(count, {
    active: 1,
    paused: 2,
    historical: 2,
    deleted: 1,
    unverified: 1,
    other: 1,
  });
});

test("account resolution maps only explicitly configured accounts", () => {
  assert.equal(resolveBusinessAccount("viora", "1825291261966849"), "viora");
  assert.equal(
    resolveBusinessAccount("trendora", "4405257269697508"),
    "trendora_facebook",
  );
  assert.equal(
    resolveBusinessAccount("trendora", "unmapped-account"),
    null,
  );
  assert.equal(
    isKnownBusinessAccount("trendora", "unmapped-account"),
    false,
  );
});

function round2ForTest(value: number) {
  return Math.round(value * 100) / 100;
}

test("campaign relationship schemas derive stable keys and reject unmapped accounts", () => {
  const reference = campaignLinkSchema.safeParse({
    store: "viora",
    accountId: "1825291261966849",
    campaign: "Winter",
  });
  assert.equal(reference.success, true);
  if (reference.success) {
    assert.equal(reference.data.key, "viora|1825291261966849|Winter");
  }

  const product = createProductSchema.safeParse({
    name: "Product",
    category: "Other",
    price: 10,
    cost: 5,
    stock: 1,
    campaigns: [
      {
        store: "viora",
        accountId: "1825291261966849",
        campaign: "Winter",
      },
      {
        store: "viora",
        accountId: "1825291261966849",
        campaign: "Winter",
      },
    ],
  });
  assert.equal(product.success, true);
  if (product.success) assert.equal(product.data.campaigns.length, 1);

  assert.equal(
    campaignLinkSchema.safeParse({
      store: "trendora",
      accountId: "unmapped-account",
      campaign: "Unmapped account",
    }).success,
    false,
  );
});
