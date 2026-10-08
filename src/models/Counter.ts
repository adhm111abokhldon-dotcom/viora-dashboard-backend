import mongoose, { Schema } from "mongoose";

/**
 * Tiny named counter used for sequential business numbers.
 *
 * One document per counter (`_id` = counter name). `$inc` is atomic, so two
 * concurrent order creations can never receive the same number - even inside
 * transactions (the update participates in the session).
 */
export interface ICounter {
  _id: string;
  seq: number;
}

export type CounterName = "orderNumber" | "productNumber";

const counterSchema = new Schema<ICounter>({
  // The counter NAME ("orderNumber"), not an ObjectId.
  _id: { type: String, required: true },
  seq: { type: Number, required: true, min: 0 },
});

const Counter = mongoose.model<ICounter>("Counter", counterSchema);

export default Counter;
