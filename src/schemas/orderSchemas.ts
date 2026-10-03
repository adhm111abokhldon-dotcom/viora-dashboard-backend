import { z } from "zod";

const itemSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number")
    .positive(),
  unitPrice: z.coerce
    .number()
    .positive("Unit price must be greater than 0"),
});

export const createOrderSchema = z.object({
  customer: z.string().trim().min(1, "Customer name is required"),
  phone: z.string().trim().min(1, "Phone number is required"),
  items: z.array(itemSchema).min(1, "Add at least one product"),
  deliveryCharged: z.coerce.number().nonnegative().default(0),
  deliveryCost: z.coerce.number().nonnegative().default(0),
});

export const updateOrderSchema = createOrderSchema;

export const updateOrderStatusSchema = z.object({
  status: z.enum(["Pending", "Delivered", "Cancelled"]),
});