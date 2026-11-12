import type { Bill, SuggestedShare } from "./tabloom.js";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normal = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const mentionsName = (clause: string, name: string) => !!name && new RegExp("(?<![\\p{L}\\p{N}_])" + escape(name) + "(?![\\p{L}\\p{N}_])", "u").test(clause);



/** Recognize complete, explicit sole-owner statements, with exact unique names. */
function soleOwner(bill: Bill, itemName: string, clause: string): string | undefined {
  const uniqueGuest = (name: string) => {
    const matches = bill.guests.filter(g => normal(g.name) === name);
    return matches.length === 1 ? matches[0].id : undefined;
  };
  const i = escape(itemName);
  const direct = new RegExp("^(?:correction: )?only (.+?) (?:ate|had) (?:the )?" + i + "(?:, not (.+))?$").exec(clause);
  if (direct) {
    const owner = uniqueGuest(direct[1]);
    if (direct[2] && (!uniqueGuest(direct[2]) || uniqueGuest(direct[2]) === owner)) return;
    return owner;
  }
  const possessive = new RegExp("^(?:correction: )?(?:the )?" + i + " (?:was|were) (.+?)['’]s alone$").exec(clause);
  if (possessive) return uniqueGuest(possessive[1]);
  const personalMeal = new RegExp("^(?:the )?" + i + " (?:was|were) (.+?)['’]s (?:meal|dish|drink)(?:, not (.+?)['’]s)?$").exec(clause);
  if (personalMeal) {
    const owner = uniqueGuest(personalMeal[1]);
    if (personalMeal[2] && (!uniqueGuest(personalMeal[2]) || uniqueGuest(personalMeal[2]) === owner)) return;
    return owner;
  }
  const corrected = new RegExp("^(.+?) initially claimed (?:the )?" + i + ", but corrected (?:herself|himself|themselves): (?:those were|that was|it was) (.+?)['’]s alone$").exec(clause);
  if (corrected && uniqueGuest(corrected[1])) return uniqueGuest(corrected[2]);
}


function namedGuests(bill: Bill, namesText: string): string[] | undefined {
  // A separator inside a guest's name makes this compact list ambiguous.
  if (bill.guests.some(g => /,| and /.test(normal(g.name)))) return;
  const names = namesText.split(/,? and |, /);
  if (names.length < 2 || new Set(names).size !== names.length) return;
  const ids: string[] = [];
  for (const name of names) {
    const guests = bill.guests.filter(g => normal(g.name) === name);
    if (guests.length !== 1) return;
    ids.push(guests[0].id);
  }
  return bill.guests.filter(g => ids.includes(g.id)).map(g => g.id);
}


/** Short corrections may name alternatives; they retract a claim, never assign owners. */
function shortNamedCorrection(bill: Bill, text: string): boolean {
  const names = [...new Set(bill.guests.map(guest => normal(guest.name)))].filter(Boolean).sort((a,b) => b.length-a.length);
  if (!names.length) return false;
  const name = "(?:" + names.map(escape).join("|") + ")";
  return new RegExp("^(?:(?:only|either|maybe|perhaps|possibly|not) )?" + name + "(?:(?:,? (?:and|or) |, )" + name + ")*$").test(text);
}

function namedGroup(bill: Bill, itemName: string, clause: string): string[] | undefined {
  if (new RegExp("^(?:everyone|everybody|all diners) (?:shared|ate|had) (?:the )?" + escape(itemName) + "$").test(clause)) {
    return bill.guests.map(guest => guest.id);
  }
  const match = new RegExp("^(.+?) (shared|ate|had|split) (?:the )?" + escape(itemName) + "( between them)?$").exec(clause);
  if (match?.[3] && match[2] !== "split") return;
  if (!match || !/ and /.test(match[1])) return;
  return namedGuests(bill, match[1]);
}


function explicitlyUnknown(itemName: string, clause: string): boolean {
  const i = escape(itemName);
  return [
    new RegExp("^(?:i|we) (?:forgot|(?:do not|don['’]t|cannot|can['’]t) (?:remember|recall)) who (?:ordered|ate|had|drank|shared) (?:the )?" + i + "$"),
    new RegExp("^(?:nobody|no one) (?:remembers|knows) who (?:ordered|ate|had) (?:the )?" + i + "$"),
    new RegExp("^(?:nobody|no one) remembers (?:the )?(?:extra )?" + i + "$"),
    new RegExp("^(?:nobody|no one) can place (?:the )?(?:extra )?" + i + "$"),
    new RegExp("^the receipt also lists (?:a |an |the )?" + i + "; (?:nobody|no one) (?:remembers|knows) who (?:ordered|ate|had) it$"),
  ].some(pattern => pattern.test(clause));
}

/** Sentence punctuation inside a supplied receipt or diner name belongs to that name. */
function noteClauses(bill: Bill): string[] {
  const text = bill.note.toLowerCase();
  const names = [...bill.items, ...bill.guests].map(entry => normal(entry.name)).filter(Boolean);
  const ranges = names.flatMap(name => [...text.matchAll(new RegExp(escape(name).replace(/ /g, "\\s+"), "g"))]
    .map(match => [match.index!, match.index! + match[0].length]));
  const parts: string[] = [];
  let start = 0;
  for (const boundary of text.matchAll(/(?<=[.!?])\s+|;\s*|\n+/g)) {
    const index = boundary.index!;
    if (ranges.some(([from, to]) => index > from && index < to)) continue;
    parts.push(text.slice(start, index));
    start = index + boundary[0].length;
  }
  parts.push(text.slice(start));
  return parts.map(part => normal(part).replace(/[.!]$/, "")).filter(Boolean);
}

/**
 * Exact declarative clauses constrain suggestions; explicit sole owners stay reviewable.
 * Unparsed related clauses prevent automatic resolution of contradictions.
 * Human review remains necessary for all model proposals.
 */
export function constrainNoteExclusions(bill: Bill, suggestions: SuggestedShare[]): SuggestedShare[] {
  const clauses = noteClauses(bill);
  const sourceClaims = [...clauses, ...clauses.slice(0,-1).map((clause,index) => clause + "; " + clauses[index+1])];
  return suggestions.map(suggestion => {
    const item = bill.items.find(item => item.id === suggestion.itemId);
    if (!item) return suggestion;
    const itemName = normal(item.name);
    if (bill.items.filter(other => normal(other.name) === itemName).length !== 1) return suggestion;
    const relevant = clauses.filter(clause => mentionsName(clause, itemName));
    if (sourceClaims.some(clause => explicitlyUnknown(itemName, clause))) return {...suggestion, guestIds: [], reason: "Your note leaves this item unclaimed. Choose who shared it."};

    let refersToItem = false;
    const followup = clauses.some(clause => {
      const qualifier = clause.replace(/\?+$/, "");
      const uncertainRecall = /^(?:(?:actually|no|wait)[,:]? )?(?:(?:i['’]m|i am|we['’]re|we are) (?:not sure|not certain|unsure|uncertain)|(?:i|we) (?:might|may|could) be wrong|not sure|not certain)$/.test(qualifier);
      const correctionName = /^(?:(?:actually|no|wait)[,:]? |correction: )(.+)$/.exec(qualifier)?.[1];
      const shortCorrection = correctionName && shortNamedCorrection(bill, correctionName);
      const negatedName = /^not (.+)$/.exec(correctionName ?? qualifier)?.[1];
      const shortExclusion = negatedName && bill.guests.some(guest => normal(guest.name) === negatedName);
      // An unknown replacement or lost recollection retracts the preceding owner;
      // an unrelated correction such as seating beside a diner does not.
      const unresolvedCorrection = correctionName && /^(?:someone else|somebody else|another diner|(?:i|we) (?:cannot|can['’]t|do not|don['’]t) (?:remember|recall|know))$/.test(correctionName);
      // A short correction names a person even when that name is also a dish.
      // Retract the preceding claim before interpreting a later item reference.
      if (refersToItem && (uncertainRecall || shortCorrection || shortExclusion || unresolvedCorrection)) return true;
      const named = bill.items.filter(other => mentionsName(clause, normal(other.name)));
      if (named.length) {
        refersToItem = named.some(other => other.id === item.id);
        return false;
      }
      return refersToItem && /\b(?:it|those|that|them)\b/.test(clause);
    });
    const explicitOwners = relevant.map(clause => {
      const sole = soleOwner(bill, itemName, clause);
      return sole ? [sole] : namedGroup(bill, itemName, clause);
    });
    if (explicitOwners.some(Boolean)) {
      // A second interpretation or unresolved reference must remain an explicit choice.
      const owners = explicitOwners[0];
      const clear = owners && explicitOwners.every(ids => ids && ids.join("\0") === owners.join("\0")) && !followup;
      return {...suggestion, guestIds: clear ? owners : [], reason: clear
        ? owners.length === 1 ? "Your note names " + bill.guests.find(g => g.id === owners[0])!.name + " alone. Check this choice before applying." : "From your note: these " + owners.length + " people shared this item. Check each person."
        : "The note contains conflicting or incomplete sharing details. Choose who shared this item."};
    }
    const excluded = new Set<string>();
    const groupExclusions = new Set<string>();
    let uncertain = false;
    for (const clause of relevant) {
      let matched = false;
      for (const guest of bill.guests) {
        const name = normal(guest.name);
        if (bill.guests.filter(other => normal(other.name) === name).length !== 1) continue;
        const g = escape(name), i = escape(itemName);
        const patterns = [
          new RegExp("^(?:everyone|everybody|all diners) (?:except|but) " + g + " (?:shared|ate|had) (?:the )?" + i + "$"),
          new RegExp("^(?:everyone|everybody|all (?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+) diners) (?:shared|ate|had) (?:the )?" + i + " (?:except|but) " + g + "$"),
          new RegExp("^" + g + " (?:did not|didn't) (?:eat|have|share) (?:the )?" + i + "$"),
          new RegExp("^" + g + " (?:paid the restaurant bill but )?ate none of (?:the )?" + i + "$"),
        ];
        const group = patterns.slice(0, 2).some(pattern => pattern.test(clause));
        if (group) {
          groupExclusions.add(guest.id);
          const count = /^all (\w+) diners /.exec(clause)?.[1];
          const counts: Record<string, number> = {two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};
          if (count && (counts[count] ?? Number(count)) !== bill.guests.length) uncertain = true;
        }
        if (group || patterns.slice(2).some(pattern => pattern.test(clause))) { excluded.add(guest.id); matched = true; }
      }
      if (!matched) uncertain = true;
    }
    if (groupExclusions.size) {
      // Different universal statements conflict; additional direct exclusions refine one group.
      const clear = !uncertain && !followup && groupExclusions.size === 1;
      return {...suggestion,
        guestIds: clear ? bill.guests.filter(guest => !excluded.has(guest.id)).map(guest => guest.id) : [],
        reason: clear
          ? "From your note: the remaining table guests shared this item. Check each person."
          : "The note contains conflicting or incomplete sharing details. Choose who shared this item."};
    }
    if (!excluded.size) return suggestion;
    // Do not choose between a recognized exclusion and a second, unparsed claim.
    const guestIds = uncertain || followup ? [] : suggestion.guestIds.filter(id => !excluded.has(id));
    return {...suggestion, guestIds, reason: uncertain || followup
      ? "The note contains conflicting or incomplete sharing details. Choose who shared this item."
      : excluded.size === 1 ? "Excluded in your note: " + bill.guests.find(g => excluded.has(g.id))!.name + ". Review the remaining people." : "Your note excludes " + excluded.size + " diners. Check the note before choosing who shared this item."};
  });
}
