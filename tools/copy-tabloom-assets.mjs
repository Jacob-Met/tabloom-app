import { cp, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "tabloom");
const output = resolve(root, "dist", "tabloom");
// Mirror the maintained browser tree, including newly imported modules and assets.
// Removing the old output prevents deleted source assets surviving an upgrade.
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
console.log(`Tabloom: ${(await readdir(source, { recursive: true })).length} browser entries bundled into dist/tabloom`);
