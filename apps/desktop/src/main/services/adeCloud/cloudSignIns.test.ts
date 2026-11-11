import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCliLoginPty } from "../ai/agentCliLoginRunner";
import { applyCloudSignIns } from "./cloudSignInBoot";
import { createCloudClaudeSignIn } from "./cloudClaudeSignIn";

/**
 * Sign-ins for cloud machines: the Codex file an older box writes from its
 * instance env at boot, and Claude's token read from Claude Code's output.
 * Only the file system and the PTY are stand-ins.
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CLAUDE_TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;

describe("applyCloudSignIns", () => {
  function home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-boot-"));
    tempDirs.push(dir);
    return dir;
  }
  const authFile = (homeDir: string) => path.join(homeDir, ".codex", "auth.json");

  it.each([
    ["not an ADE Cloud box", { OPENAI_API_KEY: "openai-test-value" }, "not_cloud"],
    ["no OpenAI key", { ADE_HOST_INSTANCE_ID: "cloud:box1" }, "no_key"],
  ] as const)("writes no Codex sign-in on %s", (_label, env, result) => {
    const homeDir = home();
    expect(applyCloudSignIns({ env: { ...env, HOME: homeDir }, homeDir })).toBe(result);
    expect(fs.existsSync(authFile(homeDir))).toBe(false);
  });

  it("writes Codex's API-key sign-in once on a box, private, and never over one already there", () => {
    const homeDir = home();
    const env = { ADE_HOST_INSTANCE_ID: "cloud:box1", OPENAI_API_KEY: " openai-test-value ", HOME: homeDir };
    expect(applyCloudSignIns({ env, homeDir })).toBe("wrote_codex_auth");
    expect(JSON.parse(fs.readFileSync(authFile(homeDir), "utf8"))).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "openai-test-value" });
    if (process.platform !== "win32") expect(fs.statSync(authFile(homeDir)).mode & 0o777).toBe(0o600);

    // A sign-in made on the machine since then is the person's, and it wins.
    fs.writeFileSync(authFile(homeDir), "{\"auth_mode\":\"chatgpt\"}\n");
    expect(applyCloudSignIns({ env: { ...env, OPENAI_API_KEY: "another-test-value" }, homeDir })).toBe("kept_existing");
    expect(fs.readFileSync(authFile(homeDir), "utf8")).toBe("{\"auth_mode\":\"chatgpt\"}\n");
  });
});

describe("createCloudClaudeSignIn", () => {
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
    const signIn = createCloudClaudeSignIn({
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
