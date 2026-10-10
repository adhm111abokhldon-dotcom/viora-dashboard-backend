import { z } from "zod";
import {
  campaignKeyFor,
  isKnownBusinessAccount,
} from "../lib/adAccounts.js";

/**
 * One advertising campaign linked to a product.
 *
 * The client sends the three identity fields; `key` is derived SERVER-SIDE
 * so a tampered or stale key can never create a phantom relationship.
 * Duplicates are removed by key - the same campaign can be listed only once
 * per product, while different accounts with identical campaign names stay
 * separate (their keys differ).
 */
export const campaignRefSchema = z
  .object({
    store: z.literal("viora"),
    accountId: z.string().trim().min(1, "Campaign account is required"),
    campaign: z.string().trim().min(1, "Campaign name is required"),
  })
  .superRefine((ref, context) => {
    if (!isKnownBusinessAccount(ref.store, ref.accountId)) {
      context.addIssue({
        code: "custom",
        path: ["accountId"],
        message: "This advertising account is not mapped",
      });
    }
  })
  .transform((ref) => ({
    ...ref,
    key: campaignKeyFor(ref.store, ref.accountId, ref.campaign),
  }));

export const campaignLinkSchema = campaignRefSchema;

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

    imageUrl: z.url("Image URL must be a valid URL").optional(),

    // Optional so older clients keep working; absent = no campaigns.
    campaigns: z
      .array(campaignRefSchema)
      .default([])
      // Deterministic order + no duplicate relationship for the same product.
      .transform((campaigns) => [
        ...new Map(campaigns.map((ref) => [ref.key, ref])).values(),
      ])
      .transform((campaigns) =>
        [...campaigns].sort((a, b) => a.key.localeCompare(b.key)),
      ),
  })
  .refine((data) => data.cost < data.price, {
    message: "Cost must be less than price",
    path: ["cost"],
  });

export const updateProductSchema = createProductSchema;
