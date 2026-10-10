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
