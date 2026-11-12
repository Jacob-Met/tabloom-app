import { Bill, calculateBill } from "./tabloom.js";
import { ValidationError } from "./errors.js";
import { previewGuestReview } from "./tabloom-guest-review.js";

/** Review all selected diners against the same saved receipt before combining their choices. */
export function previewGuestReviews(bill: Bill, tableId: string, responses: unknown) {
  if (!Array.isArray(responses) || responses.length === 0 || responses.length > bill.guests.length) {
    throw new ValidationError("Choose received responses from one or more guests on this receipt.");
  }
  const byGuest = new Map<string, ReturnType<typeof previewGuestReview>>();
  for (const response of responses) {
    const preview = previewGuestReview(bill, tableId, response);
    // previewGuestReview has already checked this guest and every item against the saved bill.
    const guestId = (response as { guestId: string }).guestId;
    if (byGuest.has(guestId)) {
      throw new ValidationError("Choose only one response from " + preview.guest + ".");
    }
    byGuest.set(guestId, preview);
  }
  const reviews = bill.guests.filter(guest => byGuest.has(guest.id)).map(guest => ({
    guestId: guest.id, guest: guest.name, changes: byGuest.get(guest.id)!.changes,
  }));
  const proposed = structuredClone(bill);
  for (const item of proposed.items) {
    const members = new Set(item.sharedBy);
    for (const review of reviews) {
      const answer = byGuest.get(review.guestId)!.bill.items.find(candidate => candidate.id === item.id)!;
      if (answer.sharedBy.includes(review.guestId)) members.add(review.guestId);
      else members.delete(review.guestId);
    }
    // Stable bill order makes simultaneous choices independent of inbox/review order.
    if (members.size !== item.sharedBy.length || item.sharedBy.some(id => !members.has(id))) {
      // Membership changes reset weights, as they do in a single guest review.
      delete item.portions;
      item.sharedBy = bill.guests.filter(guest => members.has(guest.id)).map(guest => guest.id);
    }
  }
  const unresolved = proposed.items.filter(item => !item.sharedBy.length).map(item => ({
    id: item.id, name: item.name,
  }));
  return {
    revision: bill.revision,
    reviews,
    changes: reviews.flatMap(review => review.changes.map(change => ({
      ...change, guestId: review.guestId, guest: review.guest,
    }))),
    unresolved,
    bill: proposed,
    calculated: unresolved.length ? null : calculateBill(proposed),
  };
}
