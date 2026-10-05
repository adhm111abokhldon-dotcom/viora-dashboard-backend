import mongoose, { Document, Schema } from "mongoose";

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
  createdAt: Date;
  updatedAt: Date;
}

const advertisingExpenseSchema = new Schema<IAdvertisingExpense>(
  {
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    platform: { type: String, required: true, trim: true },
    campaign: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { timestamps: true },
);

/*
 * Indexes supporting the queries the API actually runs:
 *  - default listing sorted by date descending
 *  - date-range filtering (financial summary for a 7/30 day window)
 */
advertisingExpenseSchema.index({ date: -1 });
advertisingExpenseSchema.index({ platform: 1, date: -1 });

const AdvertisingExpense = mongoose.model<IAdvertisingExpense>(
  "AdvertisingExpense",
  advertisingExpenseSchema,
);

export default AdvertisingExpense;
