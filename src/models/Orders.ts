import mongoose, { Document, Schema, Types } from "mongoose";

export type OrderStatus = "Pending" | "Delivered" | "Cancelled";

export interface IOrderItem {
  productId: Types.ObjectId;
  name: string;
  quantity: number;
  unitPrice: number; 
  unitCost: number; 
}

export interface IOrder extends Document {
  /**
   * Human-readable, persistent, sequential business number (#1, #2, ...).
   * Assigned at creation from the Counter collection - NEVER derived from
   * _id, index, sorting or pagination, and never renumbered.
   * May be missing only on documents predating the backfill migration.
   */
  orderNumber: number;
  customer: string;
  phone: string;
  items: IOrderItem[];
  deliveryCharged: number;
  deliveryCost: number; 
  total: number;
  profit: number;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<IOrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    // Sparse: pre-backfill documents simply have no number yet, and the
    // unique index only compares the documents that DO have one.
    orderNumber: { type: Number, required: true, unique: true, sparse: true },

    customer: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    items: { type: [itemSchema], required: true },
    deliveryCharged: { type: Number, default: 0, min: 0 },
    deliveryCost: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    profit: { type: Number, required: true },
    status: {
      type: String,
      enum: ["Pending", "Delivered", "Cancelled"],
      default: "Pending",
    },
  },
  { timestamps: true },
);

/*
 * Indexes for the queries the API actually runs:
 *  - product performance / product detail / products table all filter on
 *    "items.productId" (multikey index over the item array)
 *  - every list, report and dashboard window filters on status + createdAt
 */
orderSchema.index({ "items.productId": 1 });
orderSchema.index({ status: 1, createdAt: -1 });


export default mongoose.model<IOrder>("Order", orderSchema);
