import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneShareConnectTicket } from "../../../../shared/types/laneShare";
import {
  LaneShareGuestConnection,
  type LaneShareGuestSocket,
} from "./laneShareGuestConnection";

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
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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
  const sockets: FakeSocket[] = [];
  const connection = new LaneShareGuestConnection({
    grantId: GRANT_ID,
    laneId: LANE_ID,
    directory: { connect: vi.fn(async () => ticket()) },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  connections.push(connection);
  connection.start();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0]!;
  socket.open();
  socket.relay({ t: "accepted", v: 2 });
  socket.relay({ t: "ready", v: 2 });
  await vi.waitFor(() => expect(socket.sentOfType("hello")).toHaveLength(1));
  socket.deliver("hello_ok", {
    peer: {},
    brain: { deviceId: "host-1", deviceName: "Owner Mac", platform: "macOS" },
    heartbeatIntervalMs: 15_000,
    laneShareGuest: { userId: "guest-user", grants: [{ grantId: GRANT_ID, laneId: LANE_ID }] },
  });
  await vi.waitFor(() => expect(socket.sentOfType("command")).toHaveLength(1));
  const list = socket.sentOfType("command")[0]!;
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
  await vi.waitFor(() => expect(connection.listSessions().length).toBeGreaterThan(0));
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
    const sentBefore = socket.sent.length;
    socket.deliver(type, payload);
    // A message of the granted chat after it is still read, so the drop is not a stall.
    socket.deliver("chat_event", { sessionId: "chat-mine", timestamp: "t", event: { type: "text", text: "ok" } });
    await vi.waitFor(() => expect(seen).toContain("chatEvent"));
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
