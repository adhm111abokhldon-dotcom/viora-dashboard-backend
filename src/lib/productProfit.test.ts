import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateEvenly,
  currentStateAllocation,
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

test("campaign allocation reconciles exact cents for one, two, and three products", () => {
  assert.deepEqual(allocateEvenly(100, 1), [100]);
  assert.deepEqual(allocateEvenly(100, 2), [50, 50]);
  assert.deepEqual(allocateEvenly(100, 3), [33.34, 33.33, 33.33]);
  assert.equal(allocateEvenly(100, 0).length, 0);
  assert.equal(
    allocateEvenly(100, 3).reduce((sum, amount) => sum + amount, 0),
    100,
  );
});

test("current-state allocation distributes spend only to currently-linked products", () => {
  // Campaign already spent $100 BEFORE any product was linked.
  const beforeLink = currentStateAllocation(100, []);
  assert.equal(beforeLink.allocatedSpend, 0);
  assert.equal(beforeLink.unallocatedSpend, 100);

  // Link Product A today -> it receives the entire $100, not "spend since link".
  const one = currentStateAllocation(100, ["a"]);
  assert.equal(one.allocatedSpend, 100);
  assert.equal(one.unallocatedSpend, 0);
  assert.equal(one.allocationByProductId.get("a"), 100);

  // Two and three linked products split the spend exactly to the cent.
  const two = currentStateAllocation(100, ["a", "b"]);
  assert.equal(two.allocationByProductId.get("a"), 50);
  assert.equal(two.allocationByProductId.get("b"), 50);

  const three = currentStateAllocation(100, ["a", "b", "c"]);
  assert.equal(three.allocationByProductId.get("a"), 33.34);
  assert.equal(three.allocationByProductId.get("b"), 33.33);
  assert.equal(three.allocationByProductId.get("c"), 33.33);
  assert.equal(three.allocatedSpend, 100);
});

test("unlink and relink follow the current relationship, never history", () => {
  // Unlink one of two products -> the remaining product takes the full spend.
  const afterUnlink = currentStateAllocation(100, ["b"]);
  assert.equal(afterUnlink.allocationByProductId.get("b"), 100);
  assert.equal(afterUnlink.allocationByProductId.get("a"), undefined);

  // Unlink everything -> the campaign spend becomes fully unallocated again.
  const afterAllUnlinked = currentStateAllocation(100, []);
  assert.equal(afterAllUnlinked.allocatedSpend, 0);
  assert.equal(afterAllUnlinked.unallocatedSpend, 100);

  // Relink a week later -> same spend, full share again; no "resume" behaviour.
  const relinked = currentStateAllocation(100, ["a"]);
  assert.equal(relinked.allocationByProductId.get("a"), 100);
});

test("attribution tracks the selected period's campaign spend", () => {
  const expensive = currentStateAllocation(250, ["a", "b"]);
  assert.equal(expensive.allocationByProductId.get("a"), 125);
  assert.equal(expensive.allocationByProductId.get("b"), 125);

  const cheaper = currentStateAllocation(80, ["a", "b"]);
  assert.equal(cheaper.allocationByProductId.get("a"), 40);
  assert.equal(cheaper.allocationByProductId.get("b"), 40);
});

test("a deleted product is not treated as currently linked", () => {
  const allocation = currentStateAllocation(100, ["b"]);
  assert.equal(allocation.allocationByProductId.get("deleted"), undefined);
  assert.equal(allocation.linkedProductIds.length, 1);
  assert.equal(allocation.allocationByProductId.get("b"), 100);
});

test("a product's advertising cost sums its share across all linked campaigns", () => {
  const campaign1 = currentStateAllocation(100, ["a"]);
  const campaign2 = currentStateAllocation(60, ["a", "b"]);
  const campaign3 = currentStateAllocation(40, ["a"]);

  const productA =
    (campaign1.allocationByProductId.get("a") ?? 0) +
    (campaign2.allocationByProductId.get("a") ?? 0) +
    (campaign3.allocationByProductId.get("a") ?? 0);
  const productB = campaign2.allocationByProductId.get("b") ?? 0;

  assert.equal(productA, 170); // 100 + 30 + 40
  assert.equal(productB, 30);
});

test("current-state allocation always reconciles to the cent", () => {
  for (const spend of [100, 78.05, 0.01, 33.33, 250]) {
    for (const count of [0, 1, 2, 3, 5]) {
      const ids = Array.from({ length: count }, (_, index) => `p${index}`);
      const result = currentStateAllocation(spend, ids);
      assert.equal(
        result.campaignSpend,
        Math.round((result.allocatedSpend + result.unallocatedSpend) * 100) /
          100,
      );
      const summed = [...result.allocationByProductId.values()].reduce(
        (sum, amount) => sum + amount,
        0,
      );
      assert.equal(Math.round(summed * 100) / 100, result.allocatedSpend);
      if (count === 0) {
        assert.equal(result.allocatedSpend, 0);
        assert.equal(result.unallocatedSpend, spend);
      }
    }
  }
});

test("link and unlink changes affect new snapshots without rewriting history", () => {
  const beforeLink = currentStateAllocation(100, []);
  const afterFirstLink = currentStateAllocation(100, ["p1"]);
  const afterSecondLink = currentStateAllocation(100, ["p1", "p2"]);
  const afterUnlink = currentStateAllocation(100, ["p2"]);
  const afterAllUnlinked = currentStateAllocation(100, []);

  assert.equal(beforeLink.allocatedSpend, 0);
  assert.equal(beforeLink.unallocatedSpend, 100);
  assert.equal(afterFirstLink.allocationByProductId.get("p1"), 100);
  assert.equal(afterSecondLink.allocationByProductId.get("p1"), 50);
  assert.equal(afterSecondLink.allocationByProductId.get("p2"), 50);
  assert.equal(afterUnlink.allocationByProductId.get("p2"), 100);
  assert.equal(afterAllUnlinked.allocatedSpend, 0);
  assert.equal(afterAllUnlinked.unallocatedSpend, 100);
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
  const key = campaignKeyFor("viora", "account-2", "October | Beauty");
  assert.deepEqual(parseCampaignKey(key), {
    store: "viora",
    accountId: "account-2",
    campaign: "October | Beauty",
  });

  test("campaign identities survive Arabic and URL-sensitive campaign names", () => {
    const campaign = "عرض / خصم?10% #1 | Winter";
    const key = campaignKeyFor("viora", "account-2", campaign);
    assert.deepEqual(parseCampaignKey(key), {
      store: "viora",
      accountId: "account-2",
      campaign,
    });
    assert.equal(decodeURIComponent(encodeURIComponent(key)), key);
  });
  assert.equal(
    parseCampaignKey("other|account-2|October | Beauty"),
    null,
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

test("account resolution exposes only the verified Viora account", () => {
  assert.equal(resolveBusinessAccount("viora", "1825291261966849"), "viora");
  assert.equal(
    resolveBusinessAccount("viora", "unmapped-account"),
    null,
  );
  assert.equal(
    isKnownBusinessAccount("other", "1825291261966849"),
    false,
  );
});

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
      store: "viora",
      accountId: "unmapped-account",
      campaign: "Unmapped account",
    }).success,
    false,
  );
  assert.equal(
    campaignLinkSchema.safeParse({
      store: "other",
      accountId: "1825291261966849",
      campaign: "Invalid store",
    }).success,
    false,
  );
});
