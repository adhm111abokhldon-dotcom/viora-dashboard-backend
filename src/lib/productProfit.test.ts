import assert from "node:assert/strict";
import test from "node:test";
import { allocateEvenly } from "./campaignAllocation.js";
import { calculateProductProfit } from "./productProfit.js";
import {
  campaignKeyFor,
  isIgnoredAccount,
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
  assert.deepEqual(allocateEvenly(100, 3), [33.33, 33.33, 33.34]);
  assert.equal(allocateEvenly(100, 0).length, 0);
  assert.equal(
    allocateEvenly(100, 3).reduce((sum, amount) => sum + amount, 0),
    100,
  );
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
  assert.notEqual(
    campaignKeyFor("viora", "account-2", "October | Beauty"),
    key,
  );
});

test("account resolution deterministically maps known accounts and ignores ADHM", () => {
  assert.equal(resolveBusinessAccount("viora", "1825291261966849"), "viora");
  assert.equal(
    resolveBusinessAccount("trendora", "4405257269697508"),
    "trendora_facebook",
  );
  assert.equal(isIgnoredAccount("1783521163010511"), true);
  assert.equal(
    resolveBusinessAccount("trendora", "1783521163010511"),
    null,
  );
});

test("campaign relationship schemas derive stable keys and reject duplicates/ADHM", () => {
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
      accountId: "1783521163010511",
      campaign: "Wrong account",
    }).success,
    false,
  );
});
