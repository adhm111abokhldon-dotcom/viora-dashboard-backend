import type { ClientSession } from "mongoose";
import Counter, { type CounterName } from "../models/Counter.js";
import Order from "../models/Orders.js";
import Product from "../models/Product.js";

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

async function ensureCounter(
  id: CounterName,
  highest: number,
): Promise<void> {
  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: id },
      { $max: { seq: highest } },
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    if (!counter) {
      throw new Error(`Failed to initialize the ${id} counter`);
    }
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const counter = await Counter.findOneAndUpdate(
      { _id: id },
      { $max: { seq: highest } },
      { returnDocument: "after" },
    );

    if (!counter) {
      throw new Error(`Failed to initialize the ${id} counter`);
    }
  }
}

/** Initialize or advance counters to cover assigned business numbers. */
export async function ensureBusinessNumberCounters(): Promise<void> {
  const [[order], [product]] = await Promise.all([
    Order.aggregate<{ value: number }>([
      { $group: { _id: null, value: { $max: "$orderNumber" } } },
    ]),
    Product.aggregate<{ value: number }>([
      { $group: { _id: null, value: { $max: "$productNumber" } } },
    ]),
  ]);

  await Promise.all([
    ensureCounter("orderNumber", order?.value ?? 0),
    ensureCounter("productNumber", product?.value ?? 0),
  ]);
}

export async function assertBusinessNumbersComplete(): Promise<void> {
  const [ordersValid, productsValid] = await Promise.all([
    isBusinessNumberSequenceComplete(
      Order.find().select("orderNumber").sort({ createdAt: 1, _id: 1 }).lean().cursor(),
      "orderNumber",
    ),
    isBusinessNumberSequenceComplete(
      Product.find().select("productNumber").sort({ createdAt: 1, _id: 1 }).lean().cursor(),
      "productNumber",
    ),
  ]);

  if (!ordersValid || !productsValid) {
    throw new Error(
      "Business numbering is missing, invalid, duplicated, or out of sequence; run `npm run migrate:business-numbers -- --verify` before starting the API",
    );
  }
}

export async function isBusinessNumberSequenceComplete<T extends {
  orderNumber?: number;
  productNumber?: number;
}>(
  records: AsyncIterable<T>,
  field: "orderNumber" | "productNumber",
): Promise<boolean> {
  let previous = 0;
  for await (const record of records) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= previous) {
      return false;
    }
    previous = value;
  }
  return true;
}

/**
 * Atomically allocate a sequential business number.
 *
 * The counter increment participates in an order-creation transaction when
 * `session` is supplied; both order and product creation use their
 * respective transactions so a failed create does not consume a number.
 */
async function nextBusinessNumber(
  id: CounterName,
  session?: ClientSession,
): Promise<number> {
  const counter = await Counter.findByIdAndUpdate(
    id,
    { $inc: { seq: 1 } },
    { returnDocument: "after", session },
  );

  if (!counter) {
    throw new Error(
      `Business-number counter ${id} is missing; initialize it before creating records`,
    );
  }

  return counter.seq;
}

export function nextOrderNumber(session?: ClientSession): Promise<number> {
  return nextBusinessNumber("orderNumber", session);
}

export function nextProductNumber(session?: ClientSession): Promise<number> {
  return nextBusinessNumber("productNumber", session);
}
