// One matcher for every kind of evidence about who had what: chat, spoken lines, the payer's answers,
// a typed note, positions in a video frame and past dinners. Pure functions, no DOM.
import { analyzeChat } from "./chat-intake.js";

export const SOURCE_WEIGHTS = { payer: 1, chat: 0.7, voice: 0.7, note: 0.6, position: 0.4, history: 0.3, default: 0.1 };
export const AMBIGUOUS_WEIGHT = 0.3;
const SURE = 0.8, LIKELY = 0.45, STRONG = 0.5;
const DRINK_WORDS = /\b(tea|coffee|espresso|latte|cappuccino|water|soda|cola|coke|juice|lemonade|beer|lager|ale|wine|prosecco|champagne|cocktail|spritz|margarita|mojito|gin|vodka|whisky|whiskey|rum|sake|cider|smoothie|drink|drinks|mocktail|tonic)\b/i;
const NOT_RE = /\b(not mine|isn'?t mine|wasn'?t mine|didn'?t (?:have|order|get)|did not (?:have|order)|i (?:didn'?t|did not)|not me|not for me)\b/i;
const SHARED_RE = /\b(shared?|sharing|split|splitting|between us|halves|half)\b/i;

export const isDrink = item => DRINK_WORDS.test(String((item && item.name) || ""));

/** Normalise one claim: fills in the default weight and kind. */
export function claim({ personId, itemId, source = "default", weight, text = "", kind = "had", ...rest }) {
  const w = weight ?? SOURCE_WEIGHTS[source] ?? SOURCE_WEIGHTS.default;
  return { personId, itemId, source, weight: Math.max(0, Math.min(1, w)), text, kind, ...rest };
}

/** Turn analyzeChat output for a list of messages into claims. source: "chat" (default) or "voice". */
export function collectFromMessages({ messages, ownerBySender, guests, items, menuText = "", source = "chat" }) {
  const r = analyzeChat({ messages, ownerBySender, guests, items, menuText });
  const out = [];
  const kindOf = text => (NOT_RE.test(text) ? "not" : SHARED_RE.test(text) ? "shared" : "had");
  for (const x of r.resolved) {
    if (!x.guestId) continue;
    const text = messages[x.msg].text;
    out.push(claim({ personId: x.guestId, itemId: x.itemId, source, text, kind: kindOf(text) }));
  }
  for (const a of r.ambiguous) {
    for (const itemId of a.itemIds) {
      out.push(claim({ personId: a.guestId, itemId, source, text: a.text, weight: AMBIGUOUS_WEIGHT * (SOURCE_WEIGHTS[source] / SOURCE_WEIGHTS.chat), kind: kindOf(a.text) === "not" ? "not" : "had", ambiguous: true, group: `${source}:${a.msg}:${a.guestId}` }));
    }
  }
  return out;
}

const combine = ws => 1 - ws.reduce((p, w) => p * (1 - w), 1);
const priceOf = it => Math.max(1, Number(it.priceCents ?? it.cents ?? it.price ?? 0) || 0);
const asList = v => (Array.isArray(v) ? v : v ? [v] : []);

/** Combine all claims into one verdict per item. */
export function fuse({ claims, guests = [], items, quantities = {} }) {
  const known = new Set(guests.map(g => g.id));
  const all = claims.map(c => (c.weight === undefined || c.kind === undefined ? claim(c) : c)).filter(c => !known.size || known.has(c.personId));
  // An ambiguous mention ("the chicken") gives way to a sibling item that has firmer evidence for the same person.
  const firm = new Set(all.filter(c => !c.ambiguous && c.kind !== "not").map(c => `${c.personId}\u0000${c.itemId}`));
  const groups = {};
  for (const c of all) if (c.ambiguous) (groups[c.group] ||= []).push(c);
  const dropped = new Set();
  for (const g of Object.values(groups)) {
    const backed = g.filter(c => firm.has(`${c.personId}\u0000${c.itemId}`));
    if (backed.length === 1) for (const c of g) if (c !== backed[0]) dropped.add(c);
  }
  const live = all.filter(c => !dropped.has(c));
  return items.map(item => fuseItem(item, live.filter(c => c.itemId === item.id), quantities[item.id] || 1));
}

function fuseItem(item, cs, qty) {
  const because = list => list.map(c => ({ source: c.source, text: c.text, personId: c.personId, ...(c.kind !== "had" ? { kind: c.kind } : {}) }));
  const base = { itemId: item.id, payers: [], confidence: 0, state: "nobody", because: [] };
  const byPerson = {};
  for (const c of cs) (byPerson[c.personId] ||= []).push(c);
  const removed = new Set(), score = {}, shared = new Set(), coveredBy = {}, ruled = new Set();
  for (const [pid, list] of Object.entries(byPerson)) {
    const pos = list.filter(c => c.kind !== "not");
    if (list.some(c => c.kind === "not" && c.source === "payer")) { removed.add(pid); continue; }
    if (list.some(c => c.kind === "not") && !pos.some(c => c.source === "payer")) { removed.add(pid); continue; }
    if (!pos.length) continue;
    score[pid] = pos.some(c => c.source === "payer") ? 1 : combine(pos.map(c => c.weight));
    if (pos.some(c => c.kind === "shared")) shared.add(pid);
    const cov = pos.find(c => c.kind === "covered-by" && asList(c.by).length);
    if (cov) coveredBy[pid] = asList(cov.by);
    if (pos.some(c => c.source === "payer")) ruled.add(pid);
  }
  const because_ = cs; // every claim, including removed people, explains the verdict
  const withCover = ids => [...new Set(ids.flatMap(p => coveredBy[p] || [p]))];
  const done = (payers, confidence, state, extra = {}) => ({ ...base, payers: withCover(payers), confidence: Math.round(confidence * 1000) / 1000, state, because: because(because_), ...extra });
  const stateOf = conf => (conf >= SURE ? "sure" : conf >= LIKELY ? "likely" : "ask");

  if (ruled.size) { // the payer's own answer always wins
    const ids = [...ruled];
    return done(ids, 1, "sure");
  }
  const cands = Object.keys(score).sort((a, b) => score[b] - score[a]);
  if (!cands.length) return { ...base, because: because(because_), question: { type: "who-had", itemId: item.id, ...(isDrink(item) ? { grouped: "drinks" } : {}) } };
  const onlyAmbiguous = pid => byPerson[pid].filter(c => c.kind !== "not").every(c => c.ambiguous);
  if (qty > 1) {
    const conf = Math.min(...cands.map(p => score[p]));
    if (cands.length === qty) return done(cands, conf, stateOf(conf));
    return done(cands, conf, "ask", { question: { type: "who-had", itemId: item.id, quantity: qty, candidates: cands } });
  }
  const strong = cands.filter(p => score[p] > STRONG);
  if (strong.length > 1) {
    if (cands.some(p => shared.has(p))) { const ids = cands.filter(p => score[p] >= 0.3 || shared.has(p)); const conf = Math.min(...ids.map(p => score[p])); return done(ids, conf, stateOf(conf)); }
    return done([], score[strong[0]], "ask", { question: { type: "conflict", itemId: item.id, candidates: strong } });
  }
  const top = cands[0];
  if (shared.has(top) && cands.length > 1 && cands.filter(p => shared.has(p)).length > 1) { const ids = cands.filter(p => shared.has(p)); const conf = Math.min(...ids.map(p => score[p])); return done(ids, conf, stateOf(conf)); }
  const state = stateOf(score[top]);
  if (state === "ask") {
    const amb = onlyAmbiguous(top) ? byPerson[top].find(c => c.ambiguous) : null;
    const question = amb ? { type: "which-item", itemId: item.id, personId: top, text: amb.text } : { type: "who-had", itemId: item.id, candidates: cands };
    return done([top], score[top], "ask", { question });
  }
  return done([top], score[top], state);
}

/** Counts, plus the questions to put to the payer, most valuable (price x doubt) first. Drinks nobody mentioned come as one question. */
export function summary(fused, items = []) {
  const price = {}, name = {};
  for (const it of items) { price[it.id] = priceOf(it); name[it.id] = it.name; }
  const counts = { sure: 0, likely: 0, ask: 0, nobody: 0 };
  const questions = [];
  const drinks = { type: "who-had", grouped: "drinks", itemIds: [], value: 0 };
  for (const f of fused) {
    counts[f.state]++;
    if (!f.question) continue;
    const value = (price[f.itemId] || 1) * (1 - f.confidence);
    if (f.question.grouped === "drinks") { drinks.itemIds.push(f.itemId); drinks.value += value; }
    else questions.push({ ...f.question, itemId: f.itemId, name: name[f.itemId], value });
  }
  if (drinks.itemIds.length) questions.push(drinks);
  questions.sort((a, b) => b.value - a.value);
  return { total: fused.length, ...counts, questions };
}
