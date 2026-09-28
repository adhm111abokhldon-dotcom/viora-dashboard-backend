import { z } from "zod";

export const createOrderSchema = z.object({
  customer: z.string().trim().min(1, "Customer name is required"),
  phone: z.string().trim().min(1, "Phone number is required"),
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be greater than 0"),
  price: z.coerce.number().positive("Price must be greater than 0"),
});

export const updateOrderSchema = z.object({
  customer: z.string().trim().min(1, "Customer name is required"),
  phone: z.string().trim().min(1, "Phone number is required"),
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be greater than 0"),
  price: z.coerce.number().positive("Price must be greater than 0"),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["Pending", "Delivered", "Cancelled"]),
});
