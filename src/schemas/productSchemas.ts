import { z } from "zod";

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1, "Product name is required"),

    category: z.string().trim().min(1, "Category is required"),

    price: z.coerce.number().positive("Price must be greater than 0"),

    cost: z.coerce.number().nonnegative("Cost cannot be negative"),

    stock: z.coerce
      .number()
      .int("Stock must be a whole number")
      .nonnegative("Stock cannot be negative"),
  })
  .refine((data) => data.cost < data.price, {
    message: "Cost must be less than price",
    path: ["cost"],
  });

export const updateProductSchema = createProductSchema;
