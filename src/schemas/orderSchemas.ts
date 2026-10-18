import { z } from "zod";

const itemSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number")
    .positive(),
  unitPrice: z.coerce
    .number()
    .nonnegative("Unit price must be 0 or more (free gifts are 0)"),
});

export const createOrderSchema = z
  .object({
    customer: z.string().trim().min(1, "Customer name is required"),
    phone: z.string().trim().min(1, "Phone number is required"),
    items: z.array(itemSchema).min(1, "Add at least one product"),
    deliveryCharged: z.coerce.number().nonnegative().default(0),
    deliveryCost: z.coerce.number().nonnegative().default(0),
    /** Campaign the order is attributed to (optional). Validated against the
     *  configured business account in the route. */
    campaignKey: z.string().trim().min(1).nullish().default(null),
  })
  .superRefine((data, context) => {
    // One line per product: duplicates would split the same product across
    // several lines (the frontend already merges selections before sending).
    const seen = new Set<string>();

    data.items.forEach((item, index) => {
      if (seen.has(item.productId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "productId"],
          message: "Duplicate product in order items",
        });
      }

      seen.add(item.productId);
    });
  });

export const updateOrderSchema = createOrderSchema;

export const updateOrderStatusSchema = z.object({
  status: z.enum(["Pending", "Delivered", "Cancelled"]),
});