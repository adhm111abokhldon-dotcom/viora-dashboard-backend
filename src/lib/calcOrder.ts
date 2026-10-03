type Line = { quantity: number; unitPrice: number; unitCost: number };

export function calcOrder(
  items: Line[],
  deliveryCharged: number,
  deliveryCost: number,
) {
  const itemsTotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const itemsCost = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
  const total = itemsTotal + deliveryCharged;
  return { total, profit: total - itemsCost - deliveryCost };
}
