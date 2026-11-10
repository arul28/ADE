import { afterEach, describe, expect, it, vi } from "vitest";
import { createLaneShareGuestDirectory } from "../../../../shared/laneShareGuestDirectory";
import type { LaneShareConnectTicket } from "../../../../shared/types/laneShare";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../../lib/account";
import {
  LaneShareGuestConnection,
  type LaneShareGuestSocket,
} from "./laneShareGuestConnection";
import {
  laneShareGuestConnection,
  loadLaneShareReceived,
  retainLaneShareGuestConnection,
  useLaneShareGuestStore,
} from "./laneShareGuestStore";

/**
 * Trust rules of the guest client (lane sharing). Everything the host sends
 * is data of another person: the guest connection reads only its own lane's
 * sessions and never an owner-only envelope, and its hello carries only the
 * one-use ticket and a DPoP proof.
 */

const GRANT_ID = `ls_${"a".repeat(32)}`;
const LANE_ID = "lane-shared";
const OTHER_LANE_ID = "lane-other";
const TICKET = "T".repeat(43);

class FakeSocket implements LaneShareGuestSocket {
  readyState = 0;
  onopen: LaneShareGuestSocket["onopen"] = null;
  onmessage: LaneShareGuestSocket["onmessage"] = null;
  onclose: LaneShareGuestSocket["onclose"] = null;
  onerror: LaneShareGuestSocket["onerror"] = null;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<{ type: string; resolve: (envelope: Record<string, unknown>) => void }> = [];
  constructor(readonly url: string) {}
  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(envelope);
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.type === envelope.type) waiter.resolve(envelope);
      else this.waiters.push(waiter);
    }
  }
  /** Resolves with the first envelope of this type the client sends: the send is the receipt. */
  firstSent(type: string): Promise<Record<string, unknown>> {
    const sent = this.sentOfType(type)[0];
    if (sent) return Promise.resolve(sent);
    return new Promise((resolve) => this.waiters.push({ type, resolve }));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  relay(frame: { t: string; v: number }): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  deliver(type: string, payload: unknown, requestId: string | null = null): void {
    this.onmessage?.({
      data: JSON.stringify({ version: 1, type, requestId, compression: "none", payloadEncoding: "json", payload }),
    });
  }
  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((envelope) => envelope.type === type);
  }
}

const connections: LaneShareGuestConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop();
});

function ticket(): LaneShareConnectTicket {
  return {
    grantId: GRANT_ID,
    laneId: LANE_ID,
    repoKey: null,
    relayUrl: "wss://relay.example/connect/machine-1",
    hostOnline: true,
    ticket: TICKET,
    ticketExpiresAt: Date.now() + 120_000,
  };
}

/** A guest connection through hello, with the lane's session list answered. */
async function connectedGuest() {
  let dialed: (socket: FakeSocket) => void = () => {};
  const socketCreated = new Promise<FakeSocket>((resolve) => { dialed = resolve; });
  const connection = new LaneShareGuestConnection({
    grantId: GRANT_ID,
    laneId: LANE_ID,
    directory: { connect: vi.fn(async () => ticket()) },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      dialed(socket);
      return socket;
    },
  });
  connections.push(connection);
  connection.start();
  const socket = await socketCreated;
  socket.open();
  socket.relay({ t: "accepted", v: 2 });
  socket.relay({ t: "ready", v: 2 });
  await socket.firstSent("hello");
  socket.deliver("hello_ok", {
    peer: {},
    brain: { deviceId: "host-1", deviceName: "Owner Mac", platform: "macOS" },
    heartbeatIntervalMs: 15_000,
    laneShareGuest: { userId: "guest-user", grants: [{ grantId: GRANT_ID, laneId: LANE_ID }] },
  });
  const list = await socket.firstSent("command");
  const sessionsRead = new Promise<void>((resolve) => connection.on("sessions", () => resolve()));
  // The host would answer only its granted lane; a row of another lane is dropped here too.
  socket.deliver("command_result", {
    commandId: (list.payload as { commandId: string }).commandId,
    ok: true,
    result: [
      { id: "chat-mine", laneId: LANE_ID, toolType: "claude-chat", title: "Mine", status: "idle" },
      { id: "shell-mine", laneId: LANE_ID, toolType: "shell", title: "Shell", status: "running" },
      { id: "chat-other", laneId: OTHER_LANE_ID, toolType: "claude-chat", title: "Other", status: "idle" },
    ],
  });
  await sessionsRead;
  expect(socket.sentOfType("command")).toHaveLength(1);
  return { connection, socket };
}

describe("LaneShareGuestConnection", () => {
  it("sends a guest hello with only the ticket and a DPoP proof", async () => {
    const { socket } = await connectedGuest();
    const hello = socket.sentOfType("hello")[0]!;
    const auth = (hello.payload as { auth: Record<string, unknown> }).auth;
    expect(Object.keys(auth).sort()).toEqual(["deviceId", "dpop", "kind", "ticket"]);
    expect(auth.kind).toBe("guest");
    expect(auth.ticket).toBe(TICKET);
    expect(JSON.stringify(hello)).not.toMatch(/accountToken|relayAccountToken|secret|authorization/i);
    expect(hello.projectId ?? null).toBeNull();
    // The ticket rides only in the hello, never in the address the relay sees.
    expect(new URL(socket.url).origin + new URL(socket.url).pathname).toBe("wss://relay.example/connect/machine-1");
    expect(socket.url).not.toContain(TICKET);
  });

  it("keeps only the sessions of the granted lane", async () => {
    const { connection } = await connectedGuest();
    expect(connection.listSessions().map((session) => session.sessionId).sort()).toEqual(["chat-mine", "shell-mine"]);
  });

  it.each([
    ["a chat event of another lane's session", "chat_event", { sessionId: "chat-other", timestamp: "t", event: { type: "text", text: "x" } }],
    ["a chat event of an unsubscribed session", "chat_event", { sessionId: "shell-mine", timestamp: "t", event: { type: "text", text: "x" } }],
    ["a chat snapshot of another lane's session", "chat_subscribe", { sessionId: "chat-other", events: [] }],
    ["terminal data of another lane's session", "terminal_data", { sessionId: "chat-other", ptyId: "p", data: "x", at: "t" }],
  ])("drops %s", async (_label, type, payload) => {
    const { connection, socket } = await connectedGuest();
    connection.subscribeChat("chat-mine");
    const seen: string[] = [];
    connection.on("chatEvent", () => seen.push("chatEvent"));
    connection.on("chatSnapshot", () => seen.push("chatSnapshot"));
    connection.on("terminal", () => seen.push("terminal"));
    connection.on("sessions", () => seen.push("sessions"));
    const grantedRead = new Promise<void>((resolve) => connection.on("chatEvent", () => resolve()));
    const sentBefore = socket.sent.length;
    socket.deliver(type, payload);
    // A message of the granted chat after it is still read, so the drop is not a stall.
    socket.deliver("chat_event", { sessionId: "chat-mine", timestamp: "t", event: { type: "text", text: "ok" } });
    await grantedRead;
    expect(seen).toEqual(["chatEvent"]);
    expect(socket.sent.length).toBe(sentBefore);
  });

  it("sends commands only from its own list, with this share's lane and no project", async () => {
    const { connection, socket } = await connectedGuest();
    await expect(connection.call("sessions.delete", { sessionId: "chat-mine" })).rejects.toThrow(/forbidden_command/);
    await expect(connection.call("chat.send", { sessionId: "chat-other", text: "hi" })).rejects.toThrow(/forbidden_command/);
    void connection.call("work.listSessions", { laneId: OTHER_LANE_ID, projectId: "owner-project" }).catch(() => undefined);
    const last = socket.sentOfType("command").at(-1)!;
    const payload = last.payload as { action: string; args: Record<string, unknown>; projectId?: unknown };
    expect(payload.action).toBe("work.listSessions");
    expect(payload.args.laneId).toBe(LANE_ID);
    expect(payload.args.projectId).toBeUndefined();
    expect(payload.projectId ?? null).toBeNull();
  });
});

describe("the guest directory", () => {
  // The relay address comes from the owner's computer through the directory:
  // another person's data. The guest dials only ADE's own relay, and a ticket
  // with no address it trusts is dropped, so it never goes anywhere else.
  it.each<[string, string | null, "dial" | "offline" | "untrusted_relay"]>([
    ["ADE's relay", "wss://relay.example/connect/machine-1", "dial"],
    ["no address (the owner's computer is offline)", null, "offline"],
    ["a plain ws: address", "ws://relay.example/connect/machine-1", "untrusted_relay"],
    ["another host", "wss://relay.evil.example/connect/machine-1", "untrusted_relay"],
    ["an address with a user and password", "wss://user:pw@relay.example/connect/machine-1", "untrusted_relay"],
    ["an address with a query", "wss://relay.example/connect/machine-1?to=evil", "untrusted_relay"],
    ["a path outside /connect/", "wss://relay.example/admin/machine-1", "untrusted_relay"],
  ])("reads %s", async (_label, relayUrl, expected) => {
    const send = vi.fn(async () => ({
      status: 200,
      body: { grantId: GRANT_ID, laneId: LANE_ID, relayUrl, hostOnline: relayUrl != null, ticket: TICKET, ticketExpiresAt: Date.now() + 60_000 },
    }));
    const directory = createLaneShareGuestDirectory({ send, trustedRelayBaseUrls: () => ["https://relay.example"] });
    const connect = directory.connect({ grantId: GRANT_ID, dpopThumbprint: "D".repeat(43) });
    if (expected === "untrusted_relay") {
      await expect(connect).rejects.toThrow(/^untrusted_relay:/);
      return;
    }
    const ticketRead = await connect;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", body: { dpopThumbprint: "D".repeat(43) } }));
    expect(ticketRead.relayUrl).toBe(expected === "dial" ? relayUrl : null);
    expect(ticketRead.ticket).toBe(expected === "dial" ? TICKET : null);
  });
});

describe("the guest store across accounts", () => {
  // Shares and guest connections are the signed-in account's: a sign-out or
  // another account closes them, and a list read still on its way is dropped.
  it.each<[string, string | null]>([
    ["a sign-out", null],
    ["another account", "user_b"],
  ])("clears everything on %s", async (_label, nextUser) => {
    const signedIn = (userId: string) => ({ ...SIGNED_OUT_ACCOUNT, signedIn: true, userId });
    let finishRead: (result: { shares: unknown[]; pendingInvitesUnavailable: boolean }) => void = () => {};
    const listReceived = vi.fn(() => new Promise((resolve) => { finishRead = resolve; }));
    const connect = vi.fn(() => new Promise<LaneShareConnectTicket>(() => {}));
    const account = { status: vi.fn(async () => signedIn("user_a")) };
    vi.stubGlobal("window", { ade: { account, laneShareGuest: { listReceived, connect } } });
    try {
      publishAccountStatus(signedIn("user_a"));
      const release = retainLaneShareGuestConnection({ grantId: GRANT_ID, laneId: LANE_ID });
      expect(laneShareGuestConnection(GRANT_ID)).not.toBeNull();
      const opened = laneShareGuestConnection(GRANT_ID)!;
      const read = loadLaneShareReceived({ force: true });

      publishAccountStatus(nextUser ? signedIn(nextUser) : SIGNED_OUT_ACCOUNT);
      finishRead({ shares: [{ grantId: GRANT_ID, state: "active", laneId: LANE_ID }], pendingInvitesUnavailable: false });
      await read;

      expect(laneShareGuestConnection(GRANT_ID)).toBeNull();
      expect(opened.state.kind).toBe("idle");
      expect(useLaneShareGuestStore.getState()).toMatchObject({ received: null, connections: {}, receivedStatus: "idle" });
      release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
