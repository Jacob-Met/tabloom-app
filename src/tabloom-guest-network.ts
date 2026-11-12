import { networkInterfaces } from "node:os";
import { get, type Server } from "node:http";
import { ValidationError } from "./errors.js";
import { closeGuestListener, guestAddress, listenGuestLinks, TabloomGuestLinks } from "./tabloom-guest-links.js";
import { emptyGuestState, TabloomGuestState, type GuestState } from "./tabloom-guest-state.js";
import type { TabloomService } from "./tabloom-service.js";

export type GuestNetworkOptions = {
  interfaces?: typeof networkInterfaces;
  preferredPort?: number;
};
function refusal(message: string, statusCode = 400) {
  return Object.assign(new ValidationError(message), { statusCode });
}
export function privateGuestAddresses(readInterfaces: typeof networkInterfaces = networkInterfaces) {
  const addresses: { address: string; name: string }[] = [];
  for (const [name, entries] of Object.entries(readInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("127.")) continue;
      try { guestAddress("http://" + entry.address + ":1"); } catch { continue; }
      if (!addresses.some(item => item.address === entry.address)) addresses.push({ address: entry.address, name });
    }
  }
  // Prefer ordinary private LAN addresses to shared-address VPN adapters.
  // Every address stays available for guests who actually share that VPN.
  const rank = (address: string) => address.startsWith("100.") ? 1 : 0;
  return addresses.sort((a, b) => rank(a.address) - rank(b.address) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

/** A successful bind is insufficient on VPN adapters that discard local traffic. */
async function checkGuestListener(origin: string) {
  await new Promise<void>((resolve, reject) => {
    const request = get(origin, { agent: false }, response => {
      response.resume();
      if (response.statusCode === 503) resolve();
      else reject(refusal("The guest listener did not answer correctly on this network. Choose another shared private network.", 503));
    });
    const deadline = setTimeout(() => request.destroy(refusal("This computer cannot reach its guest listener on that network. Choose another shared private network.", 503)), 2000);
    request.once("close", () => clearTimeout(deadline));
    request.once("error", reject);
  });
}

/** Sharing resumes only at its original private address; Stop durably revokes it. */
export class TabloomGuestNetwork {
  private server?: Server;
  private tail: Promise<void> = Promise.resolve();
  private readonly interfaces: typeof networkInterfaces;
  private readonly preferredPort: number;
  private readonly store: TabloomGuestState;
  private remembered = emptyGuestState();
  private problem = "";

  constructor(private readonly service: TabloomService, options: GuestNetworkOptions = {}) {
    this.interfaces = options.interfaces ?? networkInterfaces;
    this.preferredPort = options.preferredPort ?? 3001;
    if (!Number.isInteger(this.preferredPort) || this.preferredPort < 0 || this.preferredPort > 65535) {
      throw refusal("Guest sharing needs a valid local port.");
    }
    this.store = new TabloomGuestState(service.path + ".guest-invitations.json");
    service.guestNetwork = this;
  }

  status() {
    const addresses = privateGuestAddresses(this.interfaces);
    const origin = this.server ? this.service.links?.baseUrl ?? null : null;
    const enabled = !!origin;
    const localOnly = !!origin && new URL(origin).hostname.startsWith("127.");
    const remembered = this.remembered.enabled;
    const message = this.problem || (enabled
      ? localOnly
        ? "These guest links only open on this computer. Stop sharing to choose a private network for your guests."
        : "Unexpired invitations resume on this network when you reopen Tabloom. Stop invitations to revoke them."
      : remembered
        ? "Saved invitations need their original network address and port. Resume on that network, or stop the saved invitations before choosing another."
        : addresses.length
          ? "Choose a private network shared with your guests. Reopening Tabloom resumes unexpired invitations there."
          : "No private network is available. Connect this computer and your guests to the same private Wi-Fi or VPN, then refresh.");
    return { enabled, origin, addresses, localOnly, remembered, resumeOrigin: remembered ? this.remembered.origin : null, message };
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => next);
    await previous;
    try { return await action(); } finally { release(); }
  }

  private async listen(host: string, port: number, resume?: GuestState) {
    const server = await listenGuestLinks(this.service, host, port, async links => {
      await checkGuestListener(links.baseUrl);
      const state = resume ?? await this.store.enable(links.baseUrl, this.service.links?.snapshot() ?? this.remembered.sessions);
      if (state.origin !== links.baseUrl) throw refusal("The saved guest address changed. Original invitations were not moved.", 503);
      links.setOnChange(async rows => { await this.store.saveSessions(state.epoch, rows); });
      await links.restore(state.sessions, id => this.service.table(id));
      await this.store.saveSessions(state.epoch, links.snapshot());
      this.remembered = state;
    });
    this.server = server;
    this.problem = "";
    server.once("close", () => {
      if (this.server !== server) return;
      this.server = undefined;
      this.service.setGuestLinks(undefined);
    });
  }

  private async restoreReplies() {
    if(!this.remembered.origin||this.service.links)return;
    const links=new TabloomGuestLinks(this.remembered.origin);
    await links.restore(this.remembered.sessions,id=>this.service.table(id));
    if(this.remembered.enabled)links.acceptingInvitations=false;
    else links.stopInvitations();
    const epoch=this.remembered.epoch;
    links.setOnChange(async rows=>{await this.store.saveSessions(epoch,rows);});
    this.service.setGuestLinks(links);
  }

  async initialize(value = process.env.TABLOOM_GUEST_URL) {
    return this.exclusive(async () => {
      if (this.server) return this.status();
      try {
        this.remembered = await this.store.read();
        await this.restoreReplies();
        const target = value || (this.remembered.enabled ? this.remembered.origin : null);
        if (!target) return this.status();
        const address = guestAddress(target);
        if (!address.host.startsWith("127.") && !privateGuestAddresses(this.interfaces).some(item => item.address === address.host)) {
          throw refusal("The saved guest network is not connected. Reconnect it to resume the original invitations, or stop them before choosing another network.", 503);
        }
        if (this.remembered.enabled && this.remembered.origin !== address.origin) {
          throw refusal("The configured guest address differs from your saved invitations. Stop those invitations in the organizer before changing networks.", 409);
        }
        await this.listen(address.host, address.port, this.remembered.enabled ? this.remembered : undefined);
      } catch (error) {
        this.problem = error instanceof ValidationError ? error.message : "Guest invitations could not resume at their original address and port. Check that network and close any other Tabloom using the port, then resume here.";
      }
      return this.status();
    });
  }

  async start(address: unknown) {
    return this.exclusive(async () => {
      if (typeof address !== "string" || !privateGuestAddresses(this.interfaces).some(item => item.address === address)) {
        throw refusal("Choose a private network currently assigned to this computer. Refresh the network list if it changed.");
      }
      if (this.server) {
        if (new URL(this.service.links!.baseUrl).hostname === address) return this.status();
        throw refusal("Guest sharing is already enabled. Stop the current invitations before choosing another network.", 409);
      }
      this.remembered = await this.store.read();
      if (this.remembered.enabled) {
        const old = guestAddress(this.remembered.origin!);
        if (old.host !== address) throw refusal("Stop your saved invitations before choosing another network; their original payment return address must stay fixed.", 409);
        try { await this.listen(old.host, old.port, this.remembered); }
        catch {
          this.problem = "The original invitation address or port is unavailable. Reconnect that network or close the other app using its port, then resume; stop saved invitations to start fresh.";
          throw refusal(this.problem, 503);
        }
        return this.status();
      }
      try { await this.listen(address, this.preferredPort); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && this.preferredPort !== 0) {
          await this.listen(address, 0);
        } else {
          this.problem = error instanceof ValidationError ? error.message : "Guest sharing could not start on that network. Check the connection and refresh the network list.";
          throw refusal(this.problem, 503);
        }
      }
      return this.status();
    });
  }

  async stop() {
    return this.exclusive(async () => {
      const server = this.server;
      await this.restoreReplies();
      const links = this.service.links;
      links?.stopInvitations();
      let failure: unknown;
      try { this.remembered = await this.store.disable(links?.baseUrl ?? null, links?.snapshot() ?? []);
        const epoch=this.remembered.epoch;
        links?.setOnChange(async rows=>{await this.store.saveSessions(epoch,rows);}); }
      catch (error) { failure = error; }
      this.server = undefined;
      this.service.setGuestLinks(links);
      if (server?.listening) {
        await closeGuestListener(server);
      }
      if (failure) {
        this.problem = "Invitations are closed, but the saved stop could not be written. Fix storage before reopening Tabloom.";
        throw refusal(this.problem, 503);
      }
      this.problem = "";
      return this.status();
    });
  }
}
