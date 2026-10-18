import mongoose, { Document, Schema, Types } from "mongoose";

/** One advertising campaign linked to a product (many-to-many). */
export interface ICampaignRef {
  /**
   * Stable opaque identity `store|accountId|cid:campaignId|campaignName` -
   * derived from the fields below when the product is saved, never parsed
   * back. The campaign NAME is display-only: same-named campaigns with
   * different stable ids link as separate campaigns. `campaignId` is null
   * only for links created before Windsor returned ids (legacy name-only).
   * Querying goes through this key so campaign names containing "|" are safe.
   */
  key: string;
  store: "viora";
  /** Windsor ad account id (business account resolved at read time). */
  accountId: string;
  /** Campaign display name exactly as reported by Windsor. */
  campaign: string;
  /** Stable Meta campaign id; null only for legacy name-only links. */
  campaignId?: string | null;
}

export interface IProduct extends Document {
  productNumber: number;
  name: string;
  category: string;
  price: number;
  cost: number;
  stock: number;
  imageUrl?: string;
  /**
   * Linked advertising campaigns - MANY-to-many: a product can join several
   * campaigns and a campaign can contain several products (the reverse side
   * is found by querying products on `campaigns.key`).
   *
   * Stored on the product so every relationship lives in ONE place; removing
   * a link never touches orders, historical snapshots, or the campaign's own
   * advertising spend.
   */
  campaigns: ICampaignRef[];
}

const campaignRefSchema = new Schema<ICampaignRef>(
  {
    key: { type: String, required: true, trim: true },
    store: { type: String, enum: ["viora"], required: true },
    accountId: { type: String, required: true, trim: true },
    campaign: { type: String, required: true, trim: true },
    campaignId: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const productSchema = new Schema<IProduct>(
  {
    productNumber: {
      type: Number,
      required: true,
      unique: true,
      sparse: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },

    category: {
      type: String,
      required: true,
      trim: true,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    cost: {
      type: Number,
      required: true,
      min: 0,
    },

    stock: {
      type: Number,
      min: 0,
      default: 0,
    },

    imageUrl: {
      type: String,
      trim: true,
    },

    campaigns: {
      type: [campaignRefSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Reverse lookup: "products linked to this campaign" (campaign details page,
 * allocation counting). Multikey - one index entry per linked campaign.
 */
productSchema.index({ "campaigns.key": 1 });

const Product = mongoose.model<IProduct>("Product", productSchema);

export default Product;
