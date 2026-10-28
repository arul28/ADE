import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli";
import { extractMachineTargeting } from "./cliMachineTargeting";
import { chatIdForLookup, locateChatOnAccount, routedToLocation } from "./cliChatLocate";

/**
 * "Which machine has this chat?", asked through this machine's brain. The
 * brain is the process boundary: a socket server that answers `chats.locate`
 * for itself and, through `machines.call`, for each other machine.
 */

const CHAT = "7c1d2e3f-0000-4000-8000-000000000abc";
type Machine = { machineKey: string; name: string; online: boolean; isThisMachine?: boolean };
type Answer = { found: boolean; scope?: Record<string, unknown> } | "refuse";

let dir: string;
let server: net.Server | null = null;
const savedHome = process.env.ADE_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-locate-"));
  process.env.ADE_HOME = path.join(dir, "home");
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  if (savedHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A brain whose machines answer as `answers` says; returns the machines each lookup asked. */
async function startBrain(machines: Machine[], answers: Record<string, Answer>) {
  const asked: string[] = [];
  const socketPath = path.join(dir, "b.sock");
  const answer = (method: string, params: Record<string, any>): unknown => {
    if (method === "ade/initialize") return { serverInfo: { name: "test" }, capabilities: {}, runtimeInfo: { defaultRole: "cto" } };
    if (method === "chats.locate") return answers.here ?? { found: false };
    if (method === "machines.list") return { state: "ok", machines };
    if (method === "machines.call" && params.request?.method === "chats.locate") {
      asked.push(params.machine);
      const reply = answers[params.machine] ?? { found: false };
      if (reply === "refuse") throw new Error("chats.locate isn't available to agents on another machine.");
      return { machine: { machineKey: params.machine }, result: reply };
    }
    return {};
  };
  server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
        if (message.id === undefined) continue;
        try {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method, message.params ?? {}) })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: (error as Error).message } })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  const options = parseCliArgs(["--socket", socketPath, "chat", "read", CHAT]).options;
  return { asked, options };
}

const project = (name: string) => ({ found: true, scope: { kind: "project", projectId: `p-${name}`, name, rootPath: `/x/${name}` } });
const ROSTER: Machine[] = [
  { machineKey: "k-here", name: "Studio", online: true, isThisMachine: true },
  { machineKey: "k-mbp", name: "MacBook Pro", online: true },
  { machineKey: "k-old", name: "Old Mac", online: true },
  { machineKey: "k-win", name: "Windows PC", online: false },
];

describe("locating a chat on the account", () => {
  it("finds the one machine that has it, remembers it, and falls back when the memory is stale", async () => {
    const brain = await startBrain(ROSTER, { "k-mbp": project("ADE"), "k-old": "refuse" });
    const first = await locateChatOnAccount(brain.options, CHAT);
    expect(first.matches).toEqual([expect.objectContaining({ machineKey: "k-mbp", machineName: "MacBook Pro", scope: expect.objectContaining({ projectId: "p-ADE" }) })]);
    // Offline machines are reported, never asked; an older one that refuses is "no answer".
    expect(first.offline).toEqual(["Windows PC"]);
    expect(first.unreachable).toEqual([expect.objectContaining({ machine: "Old Mac" })]);
    expect(brain.asked.sort()).toEqual(["k-mbp", "k-old"]);

    brain.asked.length = 0;
    const second = await locateChatOnAccount(brain.options, CHAT);
    expect(second.matches.map((match) => match.machineKey)).toEqual(["k-mbp"]);
    expect(brain.asked).toEqual(["k-mbp"]);

    // The chat moved: the remembered machine says no, so every machine is asked again.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const moved = await startBrain(ROSTER, { "k-old": project("ADE") });
    const third = await locateChatOnAccount(moved.options, CHAT);
    expect(third.matches.map((match) => match.machineKey)).toEqual(["k-old"]);
    expect(moved.asked[0]).toBe("k-mbp");
    expect(moved.asked.slice(1).sort()).toEqual(["k-mbp", "k-old"]);
  });

  it("answers here without asking anyone, and reports every machine that claims a chat", async () => {
    const local = await startBrain(ROSTER, { here: project("Quail"), "k-mbp": project("ADE") });
    const here = await locateChatOnAccount(local.options, CHAT);
    expect(here.matches).toEqual([expect.objectContaining({ isThisMachine: true, scope: expect.objectContaining({ name: "Quail" }) })]);
    expect(local.asked).toEqual([]);

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const twice = await startBrain(ROSTER, { "k-mbp": project("ADE"), "k-old": project("ADE") });
    const report = await locateChatOnAccount(twice.options, CHAT);
    expect(report.matches.map((match) => match.machineName).sort()).toEqual(["MacBook Pro", "Old Mac"]);
    // An ambiguous answer is not remembered.
    expect(fs.existsSync(path.join(process.env.ADE_HOME!, "cache", "chat-machines.json"))).toBe(false);
  });
});

describe("which chat commands look for their chat elsewhere, and how they are sent there", () => {
  const parsed = (argv: string[]) => extractMachineTargeting(parseCliArgs(argv));
  const elsewhere = { machineKey: "k-mbp", machineName: "MacBook Pro", isThisMachine: false };

  it.each([
    ["read", ["chat", "read", CHAT, "--text"], CHAT],
    ["send with flag-like text", ["chat", "send", CHAT, "--text", "--personal"], CHAT],
    ["--session form", ["chat", "status", "--session", CHAT], CHAT],
    ["alias", ["chats", "respond", CHAT, "--option", "2"], CHAT],
    ["a machine named", ["chat", "read", CHAT, "--machine", "MacBook Pro"], null],
    ["all machines", ["chat", "list", "--all-machines"], null],
    ["no id", ["chat", "list"], null],
    ["not a chat command", ["lanes", "show", CHAT], null],
    ["not an id", ["chat", "read", "x"], null],
  ])("%s", (_name, argv, expected) => {
    const saved = process.env.ADE_REMOTE_MCP_CONNECTION_ID;
    delete process.env.ADE_REMOTE_MCP_CONNECTION_ID;
    try {
      expect(chatIdForLookup(parsed(argv as string[]))).toBe(expected);
      // Through ADE MCP the MCP layer looks, with the app's own token.
      process.env.ADE_REMOTE_MCP_CONNECTION_ID = "c1";
      expect(chatIdForLookup(parsed(argv as string[]))).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ADE_REMOTE_MCP_CONNECTION_ID;
      else process.env.ADE_REMOTE_MCP_CONNECTION_ID = saved;
    }
  });

  it.each([
    ["project chat keeps text that looks like a flag", ["chat", "send", CHAT, "--message", "--personal", "--personal"],
      { kind: "project", projectId: "p-ADE", name: "ADE", rootPath: null }, ["chat", "send", CHAT, "--message", "--personal"]],
    ["personal chat gains the flag before --", ["chat", "send", CHAT, "--", "--message"],
      { kind: "personal" }, ["chat", "send", CHAT, "--personal", "--", "--message"]],
    ["personal chat already named", ["chat", "read", CHAT, "--personal"], { kind: "personal" }, ["chat", "read", CHAT, "--personal"]],
  ])("%s", (_name, argv, scope, command) => {
    const routed = routedToLocation(parsed(argv as string[]), { ...elsewhere, scope: scope as never });
    expect(routed.command).toEqual(command);
    expect(routed.options.machine).toBe("k-mbp");
    expect(routed.options.machineProject).toBe((scope as { projectId?: string }).projectId ?? null);
  });
});
