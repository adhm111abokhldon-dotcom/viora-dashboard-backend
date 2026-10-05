import Order from "../models/Orders.js";
import {
  BUSINESS_TIMEZONE,
  DAY_MS,
  startOfDayInTimeZone,
} from "./date.js";
import { itemPrologue, groupByProductAndOrder } from "./productStats.js";

/**
 * Shared product-level totals for a window.
 *
 * The reports endpoint and the advertising "insights" endpoint must agree on
 * profit before ads, so both call this one function. It is a straight
 * extraction of the aggregation that reports already used - the numbers it
 * returns are unchanged.
 *
 * NOTE on definitions (intentional, do not change here): this is PRODUCT
 * profit. It subtracts product cost and delivery cost, and it EXCLUDES
 * delivery fees collected from the customer (`deliveryCharged`), matching the
 * Reports page.
 */
export type ProductTotals = {
  productSales: number;
  productCost: number;
  deliveryCost: number;
  productProfit: number;
  units: number;
  deliveredOrders: number;
};

const EMPTY_TOTALS: ProductTotals = {
  productSales: 0,
  productCost: 0,
  deliveryCost: 0,
  productProfit: 0,
  units: 0,
  deliveredOrders: 0,
};

/**
 * Beirut-midnight start of a 7/30-day window, identical to what the reports
 * page uses. Extracted so both endpoints pick the same days.
 */
export function startOfWindowForRange(range: 7 | 30): Date {
  const startOfToday = startOfDayInTimeZone(new Date(), BUSINESS_TIMEZONE);

  return new Date(startOfToday.getTime() - (range - 1) * DAY_MS);
}

/** Product totals over Delivered orders created on or after `from`. */
export async function getProductTotalsFrom(from: Date): Promise<ProductTotals> {
  const rows = await Order.aggregate([
    { $match: { status: "Delivered", createdAt: { $gte: from } } },
    ...itemPrologue(),
    groupByProductAndOrder,
    {
      $group: {
        _id: null,
        productSales: { $sum: "$revenue" },
        productCost: { $sum: "$cost" },
        deliveryCost: { $sum: "$deliveryCost" },
        productProfit: { $sum: "$profit" },
        units: { $sum: "$units" },
        deliveredOrders: { $sum: 1 },
      },
    },
  ]);

  const row = rows[0];
  if (!row) return { ...EMPTY_TOTALS };

  return {
    productSales: row.productSales ?? 0,
    productCost: row.productCost ?? 0,
    deliveryCost: row.deliveryCost ?? 0,
    productProfit: row.productProfit ?? 0,
    units: row.units ?? 0,
    deliveredOrders: row.deliveredOrders ?? 0,
  };
}
