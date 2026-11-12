import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { ValidationError } from "./errors.js";
import { validateDraft } from "./tabloom.js";

export const LEGACY_TABLE = "legacy";

export function tableFile(legacyPath: string, tableId: string): string {
  if (tableId === LEGACY_TABLE) return legacyPath;
  if (!/^table-[a-f0-9]{32}$/.test(tableId)) throw new ValidationError("Choose a saved table.");
  return join(legacyPath + ".tables", tableId + ".json");
}

export async function storedTableIds(legacyPath: string): Promise<string[]> {
  let names: string[];
  try { names = await fs.readdir(legacyPath + ".tables"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [LEGACY_TABLE];
    throw error;
  }
  return [LEGACY_TABLE, ...names.filter(name => /^table-[a-f0-9]{32}\.json$/.test(name)).map(name => name.slice(0, -5))];
}

/** An immutable table identity makes a retried creation open the original, never overwrite it. */
export async function createStoredTable(legacyPath: string, tableId: unknown, input: unknown): Promise<string> {
  if (typeof tableId !== "string" || tableId === LEGACY_TABLE) throw new ValidationError("A new table identity is required.");
  const path = tableFile(legacyPath, tableId);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Enter a table name and its guests.");
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.guests) || !raw.guests.every(name => typeof name === "string")) throw new ValidationError("Enter one guest name per line.");
  const bill = validateDraft({
    title: raw.title, note: "", guests: raw.guests.map((name, i) => ({id: "guest-" + (i + 1), name})),
    items: [], taxCents: 0, tipCents: 0
  }, 0, {});
  const dir = dirname(path);
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const temp = join(dir, "." + randomUUID() + ".tmp");
  try {
    await fs.writeFile(temp, JSON.stringify(bill, null, 2) + "\n", {encoding: "utf8", mode: 0o600, flag: "wx"});
    // link publishes the complete file without replacing a table from an earlier attempt.
    try { await fs.link(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await fs.rm(temp, {force: true}).catch(() => {}); }
  return tableId;
}
