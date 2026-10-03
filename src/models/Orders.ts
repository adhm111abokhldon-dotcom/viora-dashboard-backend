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

export default mongoose.model<IOrder>("Order", orderSchema);
