import mongoose, { Document, Schema, Types } from "mongoose";

/** One advertising campaign linked to a product (many-to-many). */
export interface ICampaignRef {
  /**
   * Stable opaque identity `store|accountId|campaignName` - derived from the
   * three fields below when the product is saved, never parsed back.
   * Querying goes through this key so campaign names containing "|" are safe.
   */
  key: string;
  store: "viora" | "trendora";
  /** Windsor ad account id (business account resolved at read time). */
  accountId: string;
  /** Campaign display name exactly as reported by Windsor. */
  campaign: string;
}

export interface IProduct extends Document {
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
    store: { type: String, enum: ["viora", "trendora"], required: true },
    accountId: { type: String, required: true, trim: true },
    campaign: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const productSchema = new Schema<IProduct>(
  {
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

