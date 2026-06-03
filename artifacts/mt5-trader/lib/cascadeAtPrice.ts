/** Infer cascade direction from trigger vs live bid (below = buy, above = sell). */
export function inferCascadeDirectionFromTrigger(
  triggerPrice: number,
  liveBid: number,
): "buy" | "sell" | null {
  if (!Number.isFinite(triggerPrice) || !Number.isFinite(liveBid) || triggerPrice <= 0 || liveBid <= 0) {
    return null;
  }
  const t = parseFloat(triggerPrice.toFixed(2));
  const b = parseFloat(liveBid.toFixed(2));
  if (t > b) return "sell";
  if (t < b) return "buy";
  return null;
}
