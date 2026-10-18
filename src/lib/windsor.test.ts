import assert from "node:assert/strict";
import test from "node:test";
import {
  deduplicateCampaignDayRows,
  type WindsorRow,
} from "./windsor.js";

function makeRow(overrides: Partial<WindsorRow> = {}): WindsorRow {
  return {
    store: "viora",
    connectionId: "viora-windsor",
    accountId: "1825291261966849",
    accountName: "Viora",
    accountStatus: "ACTIVE",
    campaignEffectiveStatus: "ACTIVE",
    campaignConfiguredStatus: "ACTIVE",
    date: "2026-09-08",
    campaign: "Campaign",
    campaignId: null,
    spend: 0,
    clicks: 0,
    messages: 0,
    costPerMessage: null,
    currency: "AED",
    ...overrides,
  };
}

test("campaign-day deduplication keeps populated metrics over an empty row", () => {
  const empty = makeRow();
  const populated = makeRow({
    spend: 34.43,
    clicks: 58,
    messages: 10,
    costPerMessage: 3.44,
  });

  assert.deepEqual(
    deduplicateCampaignDayRows([empty, populated]),
    [populated],
  );
  assert.deepEqual(
    deduplicateCampaignDayRows([populated, empty]),
    [populated],
  );
});

test("campaign-day deduplication collapses exact duplicate metric rows", () => {
  const populated = makeRow({
    spend: 34.43,
    clicks: 58,
    messages: 10,
    costPerMessage: 3.44,
  });

  assert.deepEqual(
    deduplicateCampaignDayRows([populated, { ...populated }]),
    [populated],
  );
});

test("campaign-day deduplication rejects conflicting populated rows", () => {
  const first = makeRow({
    spend: 34.43,
    clicks: 58,
    messages: 10,
    costPerMessage: 3.44,
  });
  const conflicting = makeRow({
    spend: 31.01,
    clicks: 40,
    messages: 8,
    costPerMessage: 3.88,
  });

  assert.throws(
    () => deduplicateCampaignDayRows([first, conflicting]),
    /conflicting rows for the same campaign and day/,
  );
});

test("campaign-day deduplication keeps a lone populated row", () => {
  const populated = makeRow({ spend: 10, clicks: 5, messages: 2 });

  assert.deepEqual(deduplicateCampaignDayRows([populated]), [populated]);
});

test("campaign-day deduplication returns an empty array for no rows", () => {
  assert.deepEqual(deduplicateCampaignDayRows([]), []);
});

/* ------------------------------------------------------------------ */
/* Campaign-identity regression tests (spec section 12).              */
/* Identity = account_id + campaign_id. Name/caption/creative are     */
/* display-only and NEVER merge two campaigns with different ids.     */
/* ------------------------------------------------------------------ */

test("REGRESSION Test 1 - same caption, different campaign IDs stay separate", () => {
  const caption = "احصل على الثالث مجانا";
  const rows = deduplicateCampaignDayRows([
    makeRow({ campaign: caption, campaignId: "111", spend: 10 }),
    makeRow({ campaign: caption, campaignId: "222", spend: 20 }),
  ]);
  assert.equal(rows.length, 2);
  const spends = rows.map((r) => r.spend).sort((a, b) => a - b);
  assert.deepEqual(spends, [10, 20]);
  assert.deepEqual(
    rows.map((r) => r.campaignId).sort(),
    ["111", "222"],
  );
});

test("REGRESSION Test 2 - same campaign name, different IDs stay separate", () => {
  const rows = deduplicateCampaignDayRows([
    makeRow({ campaign: "345 Offer", campaignId: "111", spend: 5 }),
    makeRow({ campaign: "345 Offer", campaignId: "222", spend: 7 }),
  ]);
  assert.equal(rows.length, 2);
  const spends = rows.map((r) => r.spend).sort((a, b) => a - b);
  assert.deepEqual(spends, [5, 7]);
});

test("REGRESSION Test 3 - same campaign ID across multiple dates stays one campaign", () => {
  const rows = deduplicateCampaignDayRows([
    makeRow({ campaignId: "111", date: "2026-10-15", spend: 10 }),
    makeRow({ campaignId: "111", date: "2026-10-16", spend: 15 }),
    makeRow({ campaignId: "111", date: "2026-10-17", spend: 20 }),
  ]);
  assert.equal(rows.length, 3);
  const total = rows.reduce((sum, r) => sum + r.spend, 0);
  assert.equal(total, 45);
  assert.ok(rows.every((r) => r.campaignId === "111"));
});

test("REGRESSION Test 4 - same ID + same date + true duplicate row deduplicates", () => {
  const row = makeRow({
    campaignId: "111",
    spend: 34.43,
    clicks: 58,
    messages: 10,
    costPerMessage: 3.44,
  });
  const rows = deduplicateCampaignDayRows([row, { ...row }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.spend, 34.43);
});

test("REGRESSION Test 5 - same ID + same date + conflicting rows throw with raw rows, never silently pick", () => {
  const first = makeRow({
    campaignId: "111",
    spend: 34.43,
    clicks: 58,
    messages: 10,
    costPerMessage: 3.44,
  });
  const conflicting = makeRow({
    campaignId: "111",
    spend: 31.01,
    clicks: 40,
    messages: 8,
    costPerMessage: 3.88,
  });
  // Must throw (no silent rows[0] pick, no spend dropped or doubled) and
  // the message must carry the stable identity plus the FULL raw rows.
  assert.throws(
    () => deduplicateCampaignDayRows([first, conflicting]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      return (
        /conflicting rows for the same campaign and day/.test(message) &&
        message.includes('"campaignId":"111"') &&
        message.includes('"spend":34.43') &&
        message.includes('"spend":31.01')
      );
    },
  );
});

test("REGRESSION Test 9 - different account + same campaign ID stay separate", () => {
  const rows = deduplicateCampaignDayRows([
    makeRow({ accountId: "account-A", campaignId: "111", spend: 10 }),
    makeRow({ accountId: "account-B", campaignId: "111", spend: 20 }),
  ]);
  assert.equal(rows.length, 2);
  const spends = rows.map((r) => r.spend).sort((a, b) => a - b);
  assert.deepEqual(spends, [10, 20]);
});

test("REGRESSION live shape - same name shared by 4 IDs (Oct VIORA offer) stays 4 campaigns", () => {
  const name = "المنشور: عرض لفترة محدودة من VIORA";
  const ids = ["120255144960800038", "120255161987310038", "120255182530350038", "120255182539840038"];
  const rows = deduplicateCampaignDayRows(
    ids.map((campaignId, index) =>
      makeRow({ campaign: name, campaignId, spend: 10 + index }),
    ),
  );
  assert.equal(rows.length, 4);
  const total = rows.reduce((sum, r) => sum + r.spend, 0);
  assert.equal(total, 10 + 11 + 12 + 13);
});
