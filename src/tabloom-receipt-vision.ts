import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join, isAbsolute } from "node:path";
import { RECEIPT_VISION_MANIFEST as manifest, RECEIPT_VISION_CONFIG as config, RECEIPT_VISION_FORMAT as format, RECEIPT_VISION_PROMPT as prompt } from "./tabloom-receipt-vision-settings.js";

export const RECEIPT_IMAGE_URL_LIMIT = 6 * 1024 * 1024;
export const RECEIPT_VISION_BODY_LIMIT = RECEIPT_IMAGE_URL_LIMIT + 4096;
export class ReceiptVisionError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "ReceiptVisionError"; }
}
const abortError = () => new DOMException("Photo reading stopped", "AbortError");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const summaryKeys = ["printed_subtotal", "printed_tax", "printed_tip", "printed_discount", "printed_total"] as const;
export type VisionIssue = { field: string; raw: string | null; message: string };
export type PrintedMoney = { raw: string | null; cents: number | null };

export function validateReceiptImage(value: unknown) {
  const prefix = "data:image/png;base64,";
  if (typeof value !== "string" || value.length > RECEIPT_IMAGE_URL_LIMIT || !value.startsWith(prefix))
    throw new ReceiptVisionError("Choose a PNG photo within the local reader's 6 MiB encoded-image limit.");
  const encoded = value.slice(prefix.length);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new ReceiptVisionError("The receipt image encoding is invalid.");
  const png = Buffer.from(encoded, "base64");
  if (png.toString("base64") !== encoded || png.length < 33 ||
      !png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      png.readUInt32BE(8) !== 13 || png.toString("ascii",12,16) !== "IHDR")
    throw new ReceiptVisionError("The receipt image is not a readable PNG.");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 20_000_000)
    throw new ReceiptVisionError("Choose a receipt image up to 20 megapixels and 8192 pixels per side.");
  return { dataUrl: value, width, height, encodedBytes: value.length };
}

// Preserve model strings and uncertainty. This function never invents missing charges,
// reconciles by changing money, merges duplicate items, or produces a saved bill.
export function reviewReceiptVisionResponse(rawResponse: string) {
  if (rawResponse.length > 64_000) throw new ReceiptVisionError("The local model response is too large to review.", 502);
  let raw: unknown;
  try { raw = JSON.parse(rawResponse); } catch { throw new ReceiptVisionError("The local model did not return a complete receipt. Your draft is unchanged.", 502); }
  if (!object(raw) || !Array.isArray(raw.items) || raw.items.length > 100 ||
      summaryKeys.some(key => !Object.hasOwn(raw, key)) ||
      Object.keys(raw).some(key => key !== "items" && !summaryKeys.includes(key as typeof summaryKeys[number])))
    throw new ReceiptVisionError("The local model returned an unsupported receipt structure.", 502);
  const issues: VisionIssue[] = [{ field: "currency", raw: null, message: "Currency is unconfirmed. Use these amounts only if USD is the correct currency for this receipt." }];
  function money(value: unknown, field: string): PrintedMoney {
    if (value !== null && typeof value !== "string") throw new ReceiptVisionError("The local model returned an unsupported amount.", 502);
    if (value === null) return { raw: null, cents: null };
    // In particular, literal "None" is NOT null or zero.
    // A printed dollar sign is syntax, not currency confirmation. Keep the raw text.
    const decimal = value.startsWith("$") ? value.slice(1) : value;
    if (!/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(decimal)) {
      issues.push({ field, raw: value, message: "Check this printed amount against the photo." });
      return { raw: value, cents: null };
    }
    const [whole, fraction] = decimal.split(".");
    return { raw: value, cents: Number(whole) * 100 + Number(fraction) };
  }
  const items = raw.items.map((item: unknown, index: number) => {
    if (!object(item) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 240 ||
        /[\r\n\u0000-\u001f]/.test(item.name) || !Object.hasOwn(item, "printed_price") ||
        Object.keys(item).some(key => key !== "name" && key !== "printed_price"))
      throw new ReceiptVisionError("The local model returned an unsupported item row.", 502);
    const price = money(item.printed_price, "items." + index + ".printed_price");
    if (price.cents === null && price.raw === null) issues.push({ field: "items." + index + ".printed_price", raw: null, message: "Enter this item's printed price from the photo." });
    if (price.cents === 0) issues.push({ field: "items." + index + ".printed_price", raw: price.raw, message: "Review this zero-price row; it may describe a free item or modifier." });
    return { name: item.name, price };
  });
  if (!items.length) issues.push({ field: "items", raw: null, message: "No item rows were read. Enter them beside the photo." });
  const printed = Object.fromEntries(summaryKeys.map(key => [key, money(raw[key], key)])) as Record<typeof summaryKeys[number], PrintedMoney>;
  return { kind: "tabloom-receipt-vision-review" as const, reviewRequired: true as const, currency: "unconfirmed" as const, items, printed, issues, rawResponse };
}

// The model wire format is versioned separately from the unchanged review shape.
// Reject missing/extra slots before expanding; absent charges remain explicit null.
export function reviewReceiptVisionTupleResponse(rawResponse: string) {
  if (rawResponse.length > 64_000) throw new ReceiptVisionError("The local model response is too large to review.", 502);
  let wire: unknown;
  try { wire = JSON.parse(rawResponse); }
  catch { throw new ReceiptVisionError("The local model did not return a complete receipt. Your draft is unchanged.", 502); }
  const amount = (value: unknown) => value === null || typeof value === "string";
  if (!object(wire) || wire.v !== 1 ||
      Object.keys(wire).some(key => !["v", "items", "printed"].includes(key)) ||
      !Array.isArray(wire.items) || wire.items.length > 100 ||
      !wire.items.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === "string" && amount(row[1])) ||
      !Array.isArray(wire.printed) || wire.printed.length !== summaryKeys.length || !wire.printed.every(amount))
    throw new ReceiptVisionError("The local model returned an unsupported receipt structure.", 502);
  const printed = wire.printed;
  const expanded = {
    items: wire.items.map((row: [string, string | null]) => ({ name: row[0], printed_price: row[1] })),
    ...Object.fromEntries(summaryKeys.map((key, index) => [key, printed[index]])),
  };
  return { ...reviewReceiptVisionResponse(JSON.stringify(expanded)), rawResponse };
}

type Environment = Record<string, string | undefined>;
type Configuration = { directory: string; assets: string; python: string };
function configured(env: Environment): Configuration | null {
  const directory = env.TABLOOM_RECEIPT_REFERENCE_DIR, assets = env.TABLOOM_RECEIPT_REFERENCE_ASSETS;
  if (!directory || !assets) return null;
  if (!isAbsolute(directory) || !isAbsolute(assets)) throw new ReceiptVisionError("Local photo-reader directories must use absolute paths.", 503);
  return { directory, assets, python: env.TABLOOM_RECEIPT_REFERENCE_PYTHON || "python3" };
}

export type VisionCapacity = { availableBytes: number; cpus: number };
export async function localVisionCapacity(): Promise<VisionCapacity> {
  const text = await fs.readFile("/proc/meminfo", "utf8");
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  if (!match) throw new ReceiptVisionError("Available memory could not be checked for the local reader.",503);
  let availableBytes = Number(match[1]) * 1024;
  // Respect container headroom as well as host memory when a limit is present.
  for (const [limitPath,currentPath] of [
    ["/sys/fs/cgroup/memory.max","/sys/fs/cgroup/memory.current"],
    ["/sys/fs/cgroup/memory/memory.limit_in_bytes","/sys/fs/cgroup/memory/memory.usage_in_bytes"],
  ]) {
    try {
      const [limit,current] = await Promise.all([fs.readFile(limitPath,"utf8"),fs.readFile(currentPath,"utf8")]);
      if (/^\d+$/.test(limit.trim()) && /^\d+$/.test(current.trim())) availableBytes = Math.min(availableBytes,Math.max(0,Number(limit)-Number(current)));
    } catch { /* This cgroup layout is not present. */ }
  }
  return { availableBytes, cpus: availableParallelism() };
}
const hasCapacity = (capacity: VisionCapacity) => capacity.availableBytes >= 10 * 1024 ** 3 && capacity.cpus >= 4;
export class ReceiptVisionReader {
  private active = false;
  constructor(private readonly environment: Environment = process.env, private readonly capacity: () => Promise<VisionCapacity> = localVisionCapacity) {}
  async status() {
    const details = { model: "Qwen3.5-4B Q4_K_M", encodedImageLimit: RECEIPT_IMAGE_URL_LIMIT, busy: this.active, defaultReader: "browser" };
    if (this.active) return { ...details, configured: true, available: true, message: "A local model read is in progress." };
    if (process.platform !== "linux" || process.arch !== "x64") return { ...details, configured: false, available: false, message: "The optional local model runtime is currently supported on Linux." };
    try {
      const settings = configured(this.environment);
      if (!settings) return { ...details, configured: false, available: false, message: "The browser reader is available. The optional local model is not configured." };
      await Promise.all([
        fs.access(join(settings.directory, "run_reference.py")),
        fs.access(join(settings.assets, "bootstrap_record.json")),
        fs.stat(join(settings.assets, manifest.model.file)).then(stat => { if (stat.size !== manifest.model.bytes) throw new Error("model size"); }),
        fs.stat(join(settings.assets, manifest.projector.file)).then(stat => { if (stat.size !== manifest.projector.bytes) throw new Error("projector size"); }),
      ]);
      if (!hasCapacity(await this.capacity())) return { ...details, configured: true, available: false, message: "The optional model needs 4 available CPUs and 10 GiB of free memory. Browser reading and manual entry remain available." };
      return { ...details, configured: true, available: true, message: "Local model configured. Reading starts only when you choose it." };
    } catch {
      return { ...details, configured: true, available: false, message: "The configured local reader files are unavailable. The browser reader and manual entry are still available." };
    }
  }
  async read(image: unknown, callerSignal?: AbortSignal) {
    const input = validateReceiptImage(image);
    if (callerSignal?.aborted) throw abortError();
    if (this.active) throw new ReceiptVisionError("Another photo is being read. Stop it before starting another.", 409);
    const settings = configured(this.environment);
    if (!settings || process.platform !== "linux" || process.arch !== "x64") throw new ReceiptVisionError("The optional local model is not configured for this installation.", 503);
    this.active = true;
    let directory: string | undefined;
    const started = performance.now();
    try {
      if (!hasCapacity(await this.capacity())) throw new ReceiptVisionError("The optional model needs 4 available CPUs and 10 GiB of free memory. Use browser reading or manual entry for now.",503);
      if (callerSignal?.aborted) throw abortError();
      directory = await fs.mkdtemp(join(tmpdir(), "tabloom-receipt-vision-"));
      await fs.chmod(directory, 0o700);
      const write = (name: string, data: unknown) => fs.writeFile(join(directory!, name), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      const output = join(directory, "output");
      await Promise.all([
        write("manifest.json", manifest), write("configuration.json", config), write("response-format.json", format),
        fs.writeFile(join(directory, "request.jsonl"), JSON.stringify({ id: "receipt-photo", messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: input.dataUrl } }] }] }) + "\n", { mode: 0o600 }),
      ]);
      if (callerSignal?.aborted) throw abortError();
      const args = [join(settings.directory, "run_reference.py"), "--assets", settings.assets, "--manifest", join(directory,"manifest.json"),
        "--config", join(directory,"configuration.json"), "--prompts", join(directory,"request.jsonl"), "--output", output,
        "--response-format", join(directory,"response-format.json"),
        "--request-timeout", "180", "--run-timeout", "180"];
      await this.run(settings.python, args, callerSignal);
      if (callerSignal?.aborted) throw abortError();
      const path = join(output, "run.json"), stat = await fs.stat(path);
      if (stat.size > 16 * 1024 * 1024) throw new ReceiptVisionError("The local reader record is too large to review.", 502);
      const record = JSON.parse(await fs.readFile(path, "utf8"));
      const row = record.requests?.[0];
      if (record.manifest?.model?.sha256 !== manifest.model.sha256 || record.projector_identity?.sha256 !== manifest.projector.sha256 ||
          record.status !== "completed" || record.responses_complete !== true || record.attempted_requests !== 1 ||
          record.requests?.length !== 1 || row?.response_complete !== true || row?.finish_reason !== "stop" || typeof row?.content !== "string" ||
          JSON.stringify(row?.request?.response_format) !== JSON.stringify(format))
        throw new ReceiptVisionError("The local reader did not finish this receipt. Your draft is unchanged.", 502);
      const review = reviewReceiptVisionTupleResponse(row.content);
      if (callerSignal?.aborted) throw abortError();
      return { ...review, model: { name: manifest.model.file, sha256: manifest.model.sha256, runnerSourceSha256: record.source_sha256 ?? null, responseFormat: "tuple-v1" as const },
        elapsedMs: performance.now() - started, input: { width: input.width, height: input.height, encodedBytes: input.encodedBytes } };
    } catch (error) {
      if (callerSignal?.aborted) throw abortError();
      if (error instanceof ReceiptVisionError || (error instanceof DOMException && error.name === "AbortError")) throw error;
      throw new ReceiptVisionError("The local model could not read this photo. Check its configuration or use the browser reader or manual entry.", 503);
    } finally {
      try { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
      finally { this.active = false; }
    }
  }

  private run(executable: string, args: string[], callerSignal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      // This is a dedicated CLI/process group, never a shared model service.
      const child = spawn(executable, args, { stdio: "ignore", detached: true });
      let stopped = false, timedOut = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        child.kill("SIGTERM");
        force = setTimeout(() => {
          // The maintained CLI first reaps its own child. This is a last-resort
          // bound for a broken configured runner, confined to our new group.
          if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
        }, 22_000);
        force.unref();
      };
      const deadline = setTimeout(() => { timedOut = true; stop(); }, 180_000);
      deadline.unref();
      callerSignal?.addEventListener("abort", stop, { once: true });
      if (callerSignal?.aborted) stop();
      const cleanup = () => { clearTimeout(deadline); if (force) clearTimeout(force); callerSignal?.removeEventListener("abort", stop); };
      child.once("error", () => { cleanup(); reject(new ReceiptVisionError("The configured local reader could not start.", 503)); });
      child.once("close", code => {
        cleanup();
        if (callerSignal?.aborted) reject(abortError());
        else if (timedOut) reject(new ReceiptVisionError("The local reader timed out. Your draft is unchanged.", 504));
        else if (code !== 0) reject(new ReceiptVisionError("The local reader stopped before completing the photo. Your draft is unchanged.", 502));
        else resolve();
      });
    });
  }
}
export const receiptVisionReader = new ReceiptVisionReader();
