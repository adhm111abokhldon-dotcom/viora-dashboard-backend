import { round2 } from "./money.js";

export const BREAK_EVEN_THRESHOLD = 0.01;

export type ProfitState = "noSales" | "profitable" | "loss" | "breakEven";

export function calculateProductProfit(
  revenue: number,
  productCost: number,
  deliveryCost: number,
  advertisingCost: number,
  deliveredOrders: number,
) {
  const beforeAdsProfit = round2(revenue - productCost - deliveryCost);
  const netProfit = round2(beforeAdsProfit - advertisingCost);
  const marginPercent =
    revenue > 0 ? round2((netProfit / revenue) * 100) : 0;

  let state: ProfitState;
  if (deliveredOrders === 0 && advertisingCost === 0) {
    state = "noSales";
  } else if (Math.abs(netProfit) <= BREAK_EVEN_THRESHOLD) {
    state = "breakEven";
  } else {
    state = netProfit > 0 ? "profitable" : "loss";
  }

  return { beforeAdsProfit, netProfit, marginPercent, state };
}
