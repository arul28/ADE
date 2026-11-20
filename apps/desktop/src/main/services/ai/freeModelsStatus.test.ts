import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiClaudeAvailability, AiProviderConnections } from "../../../shared/types";
import { noteToolUse } from "../../../../../ade-cli/src/services/tools/usage";
import type { FreeModelsStatusInputs } from "./freeModelsStatus";

const RECORD = "provider-sign-in-history.json";

function inputs(overrides: { claudeReady?: boolean; localModelCount?: number } = {}): FreeModelsStatusInputs {
  return {
    claude: { auth: { ready: overrides.claudeReady === true } } as AiClaudeAvailability,
    providerConnections: {} as AiProviderConnections,
    auth: [],
    piAvailableModelIds: [],
    opencodeProviders: [],
    localModelCount: overrides.localModelCount ?? 0,
    customProviderCount: 0,
  };
}

/** A fresh process: the module keeps a "seen" answer for its lifetime. */
async function freshBuild() {
  vi.resetModules();
  return (await import("./freeModelsStatus")).buildFreeModelsStatus;
}

describe("buildFreeModelsStatus sign-in history", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const previousAdeHome = process.env.ADE_HOME;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-free-models-"));
    process.env.ADE_HOME = path.join(root, "home");
    fs.mkdirSync(process.env.ADE_HOME);
    env = { ADE_TOOLS_ROOT: path.join(root, "tools") };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousAdeHome === undefined) delete process.env.ADE_HOME;
    else process.env.ADE_HOME = previousAdeHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const record = () => JSON.parse(fs.readFileSync(path.join(process.env.ADE_HOME!, RECORD), "utf8"));

  it("keeps a person who signed in once from reading as new, and a local model is not a sign-in", async () => {
    let build = await freshBuild();
    expect(build(inputs(), env)).toMatchObject({ nothingSignedIn: true, everSignedIn: false });
    expect(record().firstSeenAt).toBeUndefined();

    // A loaded local model can chat, but leaves the record alone.
    expect(build(inputs({ localModelCount: 1 }), env)).toMatchObject({ nothingSignedIn: false, everSignedIn: false });
    expect(record().firstSeenAt).toBeUndefined();

    expect(build(inputs({ claudeReady: true }), env)).toMatchObject({ nothingSignedIn: false, everSignedIn: true });
    expect(typeof record().firstSeenAt).toBe("string");

    // Signed out, in a later process: still not a new person.
    build = await freshBuild();
    expect(build(inputs(), env)).toMatchObject({ nothingSignedIn: true, everSignedIn: true });

    // A machine with no record yet: an agent that ran here counts once;
    // OpenCode (the free models) does not.
    fs.rmSync(path.join(process.env.ADE_HOME!, RECORD));
    noteToolUse("opencode", env.ADE_TOOLS_ROOT!);
    build = await freshBuild();
    expect(build(inputs(), env).everSignedIn).toBe(false);
    fs.rmSync(path.join(process.env.ADE_HOME!, RECORD));
    noteToolUse("claude-code", env.ADE_TOOLS_ROOT!);
    build = await freshBuild();
    expect(build(inputs(), env).everSignedIn).toBe(true);
  });

  it("never overwrites a record it cannot read", async () => {
    const file = path.join(process.env.ADE_HOME!, RECORD);
    fs.writeFileSync(file, JSON.stringify({ checkedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z" }));
    const build = await freshBuild();
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (target === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return (readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readFileSync);

    // Unreadable: the answer comes from now, and the record keeps its sign-in.
    expect(build(inputs(), env)).toMatchObject({ nothingSignedIn: true, everSignedIn: false });
    vi.restoreAllMocks();
    expect(record()).toEqual({ checkedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z" });
  });
});
