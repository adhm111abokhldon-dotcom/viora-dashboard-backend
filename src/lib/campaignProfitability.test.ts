import assert from "node:assert/strict";
import test from "node:test";
import {
  isKnownBusinessAccount,
  parseCampaignKey,
} from "./adAccounts.js";

test("parseCampaignKey parses a name-only campaign key", () => {
  const parsed = parseCampaignKey("viora|1825291261966849|Spring Sale");

  assert.deepEqual(parsed, {
    store: "viora",
    accountId: "1825291261966849",
    campaignId: null,
    campaign: "Spring Sale",
  });
});

test("parseCampaignKey parses a cid: campaign key", () => {
  const parsed = parseCampaignKey(
    "viora|1825291261966849|cid:abc123|Spring Sale",
  );

  assert.deepEqual(parsed, {
    store: "viora",
    accountId: "1825291261966849",
    campaignId: "abc123",
    campaign: "Spring Sale",
  });
});

test("parseCampaignKey rejects malformed keys", () => {
  assert.equal(parseCampaignKey("bad"), null);
  assert.equal(parseCampaignKey("viora|"), null);
  assert.equal(parseCampaignKey("viora|1825291261966849"), null);
  assert.equal(parseCampaignKey("other|1825291261966849|Campaign"), null);

  // A non-Viora account is still a validly PARSED key; account validation is
  // a separate step (isKnownBusinessAccount) performed by the route.
  assert.deepEqual(parseCampaignKey("viora|wrong-account|Campaign"), {
    store: "viora",
    accountId: "wrong-account",
    campaignId: null,
    campaign: "Campaign",
  });
});

test("parseCampaignKey rejects a cid: key missing the campaign name", () => {
  assert.equal(parseCampaignKey("viora|1825291261966849|cid:abc123|"), null);
});

test("isKnownBusinessAccount validates the Viora account", () => {
  assert.equal(isKnownBusinessAccount("viora", "1825291261966849"), true);
  assert.equal(isKnownBusinessAccount("viora", "wrong-account"), false);
  assert.equal(isKnownBusinessAccount("other", "1825291261966849"), false);
  assert.equal(isKnownBusinessAccount(null, null), false);
  assert.equal(isKnownBusinessAccount(undefined, undefined), false);
});
