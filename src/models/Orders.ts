import mongoose, { Document, Schema } from "mongoose";

export type OrderStatus = "Pending" | "Delivered" | "Cancelled";

export interface IOrder extends Document {
  customer: string;
  phone: string;
  productId: mongoose.Types.ObjectId;
  product: string;
  quantity: number;
  price: number;
  total: number;
  profit: number;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<IOrder>(
  {
    customer: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      trim: true,
    },

    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    product: {
      type: String,
      required: true,
      trim: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    total: {
      type: Number,
      required: true,
      min: 0,
    },

    profit: {
      type: Number,
      required: true,
    },

    status: {
      type: String,
      enum: ["Pending", "Delivered", "Cancelled"],
      default: "Pending",
    },
  },

  {
    timestamps: true,
  },
);

const Order = mongoose.model<IOrder>("Order", orderSchema);

export default Order;
