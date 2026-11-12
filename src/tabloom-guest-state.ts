import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
import { guestAddress } from "./tabloom-guest-links.js";

export type GuestState = {
  version: 1;
  enabled: boolean;
  origin: string | null;
  epoch: string;
  sessions: unknown[];
};
export const emptyGuestState = (): GuestState => ({ version: 1, enabled: false, origin: null, epoch: "", sessions: [] });

/** Private, atomic invitation state. It never stores merchant credentials or changes a bill. */
export class TabloomGuestState {
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => next);
    await previous;
    try { return await action(); } finally { release(); }
  }

  private async load(): Promise<GuestState> {
    let text: string;
    try { text = await fs.readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyGuestState();
      throw error;
    }
    let value: GuestState;
    try { value = JSON.parse(text) as GuestState; }
    catch { throw new ValidationError("Saved guest invitations could not be read. The saved dinners are separate and remain available."); }
    if (!value || value.version !== 1 || typeof value.enabled !== "boolean" ||
        typeof value.epoch !== "string" || !Array.isArray(value.sessions) || value.sessions.length > 100 ||
        (value.origin !== null && typeof value.origin !== "string") ||
        (value.enabled && (!value.origin || !value.epoch))) {
      throw new ValidationError("Saved guest invitations are not valid. The saved dinners remain available.");
    }
    if (value.origin) guestAddress(value.origin);
    return value;
  }

  private async save(value: GuestState) {
    const folder = dirname(this.path);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const temp = join(folder, "." + randomUUID() + ".tmp");
    try {
      await fs.writeFile(temp, JSON.stringify(value) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(temp, this.path);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }

  read() { return this.exclusive(() => this.load()); }

  enable(origin: string, sessions: unknown[] = []) {
    guestAddress(origin);
    return this.exclusive(async () => {
      const state: GuestState = { version: 1, enabled: true, origin, epoch: randomUUID(), sessions: JSON.parse(JSON.stringify(sessions)) };
      await this.save(state);
      return state;
    });
  }

  saveSessions(epoch: string, sessions: unknown[]) {
    // Freeze this particular mutation before it joins the write queue.
    const snapshot = JSON.parse(JSON.stringify(sessions)) as unknown[];
    return this.exclusive(async () => {
      const state = await this.load();
      // A late operation from a stopped listener cannot revive an old invitation.
      if (state.epoch !== epoch) return false;
      if (snapshot.length > 100) throw new ValidationError("Stop an older guest invitation before adding another.");
      await this.save({ ...state, sessions: snapshot });
      return true;
    });
  }

  disable(origin: string | null = null, sessions: unknown[] = []) {
    return this.exclusive(async () => {
      const state: GuestState = { ...emptyGuestState(), origin, sessions: JSON.parse(JSON.stringify(sessions)), epoch: randomUUID() };
      await this.save(state);
      return state;
    });
  }
}
