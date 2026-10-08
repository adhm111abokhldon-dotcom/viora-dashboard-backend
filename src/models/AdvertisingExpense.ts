import mongoose, { Document, Schema } from "mongoose";

export interface IAdvertisingExpenseAllocationProduct {
  productId: string;
  productName: string;
  amount: number;
  shareIndex: number;
  shareCount: number;
}

export interface IAdvertisingExpenseAllocationSnapshot {
  campaignSpend: number;
  allocatedSpend: number;
  unallocatedSpend: number;
  capturedAt: Date;
  products: IAdvertisingExpenseAllocationProduct[];
}

/**
 * Manual advertising expenses.
 *
 * Deliberately a standalone collection: there is no attribution between an ad
 * and an order (we cannot know which COD order came from which ad), so ad
 * spend is recorded as a business expense in its own right and combined with
 * sales only at the financial-summary layer.
 */
export interface IAdvertisingExpense extends Document {
  /** Date the money was spent (business date, stored as a UTC instant). */
  date: Date;
  amount: number;
  platform: string;
  campaign?: string;
  note?: string;

  /**
   * Where the row came from. Missing on documents created before this field
   * existed, which means "manual" - no migration needed.
   */
  source?: "manual" | "windsor";

  /**
   * Stable id for a synced Windsor row: `${date}|${campaign}`.
   * Upserting on this makes a repeated sync idempotent.
   * Never set for manual rows.
   */
  externalKey?: string;

  /** Meta messaging conversations started (Windsor rows only). */
  messages?: number;

  /** Meta link clicks (Windsor rows only). */
  clicks?: number;

  /**
   * Amount exactly as Windsor reported it, BEFORE conversion (e.g. AED).
   * `amount` is the USD value used by every calculation; this keeps the
   * original visible so the owner can trace it.
   */
  originalAmount?: number;

  /** Currency of `originalAmount`, e.g. "AED". Windsor rows only. */
  originalCurrency?: string;

  /** Which store this advertising belongs to. Windsor rows only. */
  store?: "viora" | "trendora";

  /** Which Windsor connection produced the row. */
  connectionId?: string;

  /** Windsor ad account id - ONE connection can hold several. */
  accountId?: string;

  /** Windsor ad account display name, as reported by Windsor. */
  accountName?: string;

  /** Windsor account status, e.g. ACTIVE / DISABLED. */
  accountStatus?: string;

  /** Latest campaign effective status reported by Windsor. */
  campaignEffectiveStatus?: string;

  /** Campaign's configured status when Windsor provides it. */
  campaignConfiguredStatus?: string;

  /** Last successful full sync in which this campaign-day row was returned. */
  lastSeenAt?: Date;

  /** Immutable product mapping for this campaign-day spend record. */
  allocationSnapshot?: IAdvertisingExpenseAllocationSnapshot;

  createdAt: Date;
  updatedAt: Date;
}

const allocationProductSchema =
  new Schema<IAdvertisingExpenseAllocationProduct>(
    {
      productId: { type: String, required: true },
      productName: { type: String, required: true },
      amount: { type: Number, required: true, min: 0 },
      shareIndex: { type: Number, required: true, min: 0 },
      shareCount: { type: Number, required: true, min: 1 },
    },
    { _id: false },
  );

const allocationSnapshotSchema =
  new Schema<IAdvertisingExpenseAllocationSnapshot>(
    {
      campaignSpend: { type: Number, required: true, min: 0 },
      allocatedSpend: { type: Number, required: true, min: 0 },
      unallocatedSpend: { type: Number, required: true, min: 0 },
      capturedAt: { type: Date, required: true },
      products: { type: [allocationProductSchema], default: [] },
    },
    { _id: false },
  );

const advertisingExpenseSchema = new Schema<IAdvertisingExpense>(
  {
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    platform: { type: String, required: true, trim: true },
    campaign: { type: String, trim: true },
    note: { type: String, trim: true },

    // Optional on purpose: existing manual documents have no `source`.
    source: { type: String, enum: ["manual", "windsor"] },
    externalKey: { type: String, trim: true },
    messages: { type: Number, min: 0 },
    clicks: { type: Number, min: 0 },
    originalAmount: { type: Number, min: 0 },
    originalCurrency: { type: String, trim: true },
    store: { type: String, enum: ["viora", "trendora"] },
    connectionId: { type: String, trim: true },
    accountId: { type: String, trim: true },
    accountName: { type: String, trim: true },
    accountStatus: { type: String, trim: true },
    campaignEffectiveStatus: { type: String, trim: true },
    campaignConfiguredStatus: { type: String, trim: true },
    lastSeenAt: { type: Date },
    allocationSnapshot: { type: allocationSnapshotSchema },
  },
  { timestamps: true },
);

/*
 * Indexes supporting the queries the API actually runs:
 *  - default listing sorted by date descending
 *  - date-range filtering (financial summary for a 7/30 day window)
 *  - unique Windsor upserts by source + externalKey (idempotent sync)
 *  - insights split by source
 *
 * The partial unique index applies only to Windsor rows with a string key.
 * Run the deduplication migration before creating it on an existing database.
 */
advertisingExpenseSchema.index({ date: -1 });
advertisingExpenseSchema.index({ platform: 1, date: -1 });
advertisingExpenseSchema.index(
  { source: 1, externalKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: "windsor",
      externalKey: { $type: "string" },
    },
    name: "windsor_external_key_unique",
  },
);
advertisingExpenseSchema.index({ source: 1, date: -1 });
// Per-store / per-ad-account breakdowns on the advertising page.
advertisingExpenseSchema.index({ source: 1, store: 1, accountId: 1 });

const AdvertisingExpense = mongoose.model<IAdvertisingExpense>(
  "AdvertisingExpense",
  advertisingExpenseSchema,
);

export default AdvertisingExpense;
