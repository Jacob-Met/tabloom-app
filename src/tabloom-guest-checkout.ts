import type { Bill } from "./tabloom.js";
import { calculateBill, paymentRetryAllowed } from "./tabloom.js";
import { guestReviewFingerprint } from "./tabloom-guest-review.js";
import { ValidationError } from "./errors.js";

/** A diner sees only their saved allocation and their own provider result. */
export function guestCheckoutPacket(bill: Bill, tableId: string, guestId: unknown) {
  const due = calculateBill(bill).dues.find(d => d.guestId === guestId);
  if (!due || !bill.items.length) throw new ValidationError("Choose a guest on a saved receipt with items.");
  const payment = bill.payments[due.guestId];
  if (payment && payment.amountCents !== due.totalCents) {
    throw new ValidationError("This payment no longer matches the saved share. Ask the organizer to check it.");
  }
  return {
    kind: "tabloom-guest-checkout", version: 1, tableId,
    revision: bill.revision, fingerprint: guestReviewFingerprint(bill, tableId),
    title: bill.title, guestId: due.guestId, guestName: due.name,
    totalCents: due.totalCents, itemsCents: due.itemsCents,
    discountCents: due.discountCents || 0, taxCents: due.taxCents, tipCents: due.tipCents, lineItems: due.lineItems,
    paymentRequestsExist: Object.keys(bill.payments).length > 0,
    payment: payment ? {
      status: payment.status, retryAllowed:paymentRetryAllowed(payment), amountCents: payment.amountCents,
      ...(payment.orderId ? {orderId: payment.orderId} : {}),
      ...(payment.providerFailure ? {providerFailure:payment.providerFailure} : {}),
      ...(payment.approvalUrl ? {approvalUrl: payment.approvalUrl} : {}),
      ...(payment.captureId ? {captureId: payment.captureId} : {}),
      ...(payment.providerStatus ? {providerStatus:payment.providerStatus,providerCheckedAt:payment.providerCheckedAt} : {})
    } : null
  };
}
