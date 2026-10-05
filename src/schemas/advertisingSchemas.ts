import { z } from "zod";

/*
 * Platform is intentionally a free-text string rather than a strict enum:
 * the owner may run ads on a channel we have never heard of. The frontend
 * offers the common values as suggestions but the backend stays flexible.
 */

const isoDate = z
  .string()
  .min(1, "Date is required")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Date must be a valid date");

export const createAdvertisingExpenseSchema = z.object({
  date: isoDate,
  amount: z.coerce
    .number()
    .positive("Amount must be greater than 0")
    .max(10_000_000, "Amount is unrealistically large"),
  platform: z.string().trim().min(1, "Platform is required").max(60),
  campaign: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

export const updateAdvertisingExpenseSchema = createAdvertisingExpenseSchema;
