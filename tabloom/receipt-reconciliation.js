/**
 * Compare reviewed receipt amounts with the amounts printed on the source.
 * Missing printed amounts stay unknown; a matching total never certifies OCR.
 */
export function reconcileReceiptAmounts(input) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const items = input.items || [];
  const amounts = items.map(item => item.cents);
  const tax = input.taxCents ?? 0, tip = input.tipCents ?? 0;
  const discount = input.discountCents ?? 0;
  if (!amounts.every(valid) || ![tax, tip, discount].every(valid)) {
    return {status: "invalid", issues: [{kind: "amount", message: "Review the unreadable receipt amounts."}], comparisons: []};
  }
  const subtotalCents = amounts.reduce((sum, cents) => sum + cents, 0);
  const totalCents = subtotalCents - discount + tax + tip;
  if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents) || totalCents < 0 || discount > subtotalCents) {
    return {status: "invalid", issues: [{kind: "amount", message: "Review the receipt amounts and discount."}], comparisons: []};
  }
  if (input.printedTotalBeforeTip !== undefined && typeof input.printedTotalBeforeTip !== "boolean") return {status:"invalid",issues:[{kind:"total",message:"Review what the printed total includes."}],comparisons:[]};
  const comparedTotal = input.printedTotalBeforeTip === true ? totalCents - tip : totalCents;
  const comparisons = [], issues = [];
  const subtotalBasis = discount > 0 && input.printedSubtotalCents === subtotalCents - discount ? "after_discount" : "before_discount";
  const comparedSubtotal = subtotalBasis === "after_discount" ? subtotalCents - discount : subtotalCents;
  for (const [kind, printed, calculated] of [
    ["subtotal", input.printedSubtotalCents, comparedSubtotal],
    ["total", input.printedTotalCents, comparedTotal],
  ]) {
    if (printed === undefined || printed === null) continue;
    if (!valid(printed)) {
      issues.push({kind, message: "Review the printed " + kind + "."});
      continue;
    }
    const differenceCents = calculated - printed;
    comparisons.push({kind, printedCents: printed, calculatedCents: calculated, differenceCents});
    if (differenceCents) issues.push({kind, differenceCents, message: "Receipt " + kind + " differs from the entered amounts."});
  }
  return {
    status: issues.length ? "mismatch" : comparisons.length ? "matched" : "unverified",
    subtotalCents, totalCents, subtotalBasis, comparisons, issues,
  };
}
