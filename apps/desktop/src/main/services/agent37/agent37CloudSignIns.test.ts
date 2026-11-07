import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCliLoginPty } from "../ai/agentCliLoginRunner";
import type { Agent37Vault } from "./agent37Credential";
import { applyAgent37CloudSignIns } from "./agent37CloudSignInBoot";
import { createAgent37ClaudeSignIn } from "./agent37ClaudeSignIn";
import { agent37CloudSignInVaultKey, agent37MachineEnv, type Agent37CloudSignInVaults } from "./agent37CloudSignInStore";

/**
 * Sign-ins for cloud machines: the env a new machine is made with, the Codex
 * file a box writes from it at boot, and Claude's token read from Claude
 * Code's output. Only the account vault, the file system and the PTY are
 * stand-ins.
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function vaultsWith(items: Record<string, string | Error>): Agent37CloudSignInVaults {
  return (vaultKey) => {
    const vault: Agent37Vault = {
      get: async () => {
        const item = items[vaultKey];
        if (item instanceof Error) throw item;
        return { ok: true, value: item ?? null };
      },
      set: async () => true,
      remove: async () => true,
    };
    return vault;
  };
}

const stored = (token: string) => JSON.stringify({ v: 1, token, savedAt: 1 });
const CLAUDE_TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;

describe("agent37MachineEnv", () => {
  it("gives a new machine each kept sign-in in its provider's variable, and leaves out what it can't read", async () => {
    const env = await agent37MachineEnv(vaultsWith({
      [agent37CloudSignInVaultKey("claude")]: stored(CLAUDE_TOKEN),
      [agent37CloudSignInVaultKey("codex")]: stored("openai-test-value"),
      [agent37CloudSignInVaultKey("cursor")]: new Error("vault unreadable"),
      // Not Claude Code's token shape: never handed to a machine as one.
      [agent37CloudSignInVaultKey("droid")]: "not json",
    }));
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN, OPENAI_API_KEY: "openai-test-value" });
    // Signed out of ADE: no account, so a machine starts with nothing.
    expect(await agent37MachineEnv(null)).toEqual({});
    expect(await agent37MachineEnv(() => null)).toEqual({});
  });
});

describe("applyAgent37CloudSignIns", () => {
  function home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-a37-boot-"));
    tempDirs.push(dir);
    return dir;
  }
  const authFile = (homeDir: string) => path.join(homeDir, ".codex", "auth.json");

  it.each([
    ["not an Agent 37 box", { OPENAI_API_KEY: "openai-test-value" }, "not_agent37"],
    ["no OpenAI key", { ADE_HOST_INSTANCE_ID: "agent37:box1" }, "no_key"],
  ] as const)("writes no Codex sign-in on %s", (_label, env, result) => {
    const homeDir = home();
    expect(applyAgent37CloudSignIns({ env: { ...env, HOME: homeDir }, homeDir })).toBe(result);
    expect(fs.existsSync(authFile(homeDir))).toBe(false);
  });

  it("writes Codex's API-key sign-in once on a box, private, and never over one already there", () => {
    const homeDir = home();
    const env = { ADE_HOST_INSTANCE_ID: "agent37:box1", OPENAI_API_KEY: " openai-test-value ", HOME: homeDir };
    expect(applyAgent37CloudSignIns({ env, homeDir })).toBe("wrote_codex_auth");
    expect(JSON.parse(fs.readFileSync(authFile(homeDir), "utf8"))).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "openai-test-value" });
    if (process.platform !== "win32") expect(fs.statSync(authFile(homeDir)).mode & 0o777).toBe(0o600);

    // A sign-in made on the machine since then is the person's, and it wins.
    fs.writeFileSync(authFile(homeDir), "{\"auth_mode\":\"chatgpt\"}\n");
    expect(applyAgent37CloudSignIns({ env: { ...env, OPENAI_API_KEY: "another-test-value" }, homeDir })).toBe("kept_existing");
    expect(fs.readFileSync(authFile(homeDir), "utf8")).toBe("{\"auth_mode\":\"chatgpt\"}\n");
  });
});

describe("createAgent37ClaudeSignIn", () => {
  function fakeClaudeCode() {
    let emit: (data: string) => void = () => undefined;
    let exit: (event: { exitCode: number }) => void = () => undefined;
    const stopped: AgentCliLoginPty[] = [];
    const pty: AgentCliLoginPty = {
      pid: 1,
      onData: (listener) => { emit = listener; },
      onExit: (listener) => { exit = listener; },
      write: () => undefined,
      kill: () => undefined,
    };
    const signIn = createAgent37ClaudeSignIn({
      resolveCli: () => ({ kind: "ready", cli: { command: "/tools/claude", leadingArgs: [], env: {} } }),
      baseEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: "an-old-token" }),
      spawnPty: () => pty,
      stopPty: (target) => { stopped.push(target); },
    });
    return { pty, signIn, stopped, emit: (data: string) => emit(data), exit: (exitCode: number) => exit({ exitCode }) };
  }
  // A save's answer settles on the next turn of the event loop.
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("saves the token only once it is whole, though the output cuts it in two, then stops Claude Code", async () => {
    const { pty, signIn, stopped, emit } = fakeClaudeCode();
    const saved: string[] = [];
    signIn.start(async (token) => {
      saved.push(token);
      return true;
    });

    emit(`Your token:\r\n${CLAUDE_TOKEN.slice(0, 40)}`);
    expect(saved).toEqual([]);
    expect(signIn.state()?.state).toBe("running");

    emit(`${CLAUDE_TOKEN.slice(40)}\r\nStore it safely.\r\n`);
    await settled();
    expect(saved).toEqual([CLAUDE_TOKEN]);
    expect(signIn.state()?.state).toBe("succeeded");
    expect(stopped).toEqual([pty]);
  });

  it("never stops a Claude Code that already exited while its token was saving", async () => {
    // On Windows a stop kills the process tree by PID, and a PID that exited
    // can already belong to another process.
    const { signIn, stopped, emit, exit } = fakeClaudeCode();
    let answer: (ok: boolean) => void = () => undefined;
    signIn.start(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    emit(`${CLAUDE_TOKEN}\r\n`);
    expect(signIn.state()?.state).toBe("saving");
    exit(0);
    answer(false);
    await settled();
    expect(signIn.state()?.state).toBe("failed");
    expect(stopped).toEqual([]);
  });
});
