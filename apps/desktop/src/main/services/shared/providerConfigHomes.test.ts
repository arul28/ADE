import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOME = "/home/tester";

// The module imports `{ homedir }` by name, so a spy on the default export
// would not intercept it — that named import is deliberate, because suites that
// mock node:os by spreading the real module leave the default export intact.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal() as object),
  homedir: () => HOME,
}));

const { claudeConfigHome, codexConfigHome, factoryConfigHome } = await import("./providerConfigHomes");
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "FACTORY_HOME_OVERRIDE"] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("providerConfigHomes", () => {
  it("falls back to the home directory for every provider", () => {
    expect(claudeConfigHome()).toBe(path.join(HOME, ".claude"));
    expect(codexConfigHome()).toBe(path.join(HOME, ".codex"));
    expect(factoryConfigHome()).toBe(path.join(HOME, ".factory"));
  });

  it("treats CLAUDE_CONFIG_DIR and CODEX_HOME as the config directory itself", () => {
    process.env.CLAUDE_CONFIG_DIR = "/somewhere/claude-cfg";
    process.env.CODEX_HOME = "/somewhere/codex-cfg";
    expect(claudeConfigHome()).toBe("/somewhere/claude-cfg");
    expect(codexConfigHome()).toBe("/somewhere/codex-cfg");
  });

  it("treats FACTORY_HOME_OVERRIDE as a HOME with .factory appended", () => {
    // This is the asymmetry the module exists for. Droid resolves
    // `join($R(), ".factory")` where $R() is FACTORY_HOME_OVERRIDE || homedir(),
    // so the var names the parent, not the config directory — the opposite of
    // the other two. Getting it wrong makes ADE read a directory the spawned
    // droid process never touches.
    process.env.FACTORY_HOME_OVERRIDE = "/somewhere/fake-home";
    expect(factoryConfigHome()).toBe(path.join("/somewhere/fake-home", ".factory"));
  });

  it("prefers an explicit homeDir over homedir(), and the env var over both", () => {
    expect(factoryConfigHome({ homeDir: "/explicit" })).toBe(path.join("/explicit", ".factory"));
    process.env.FACTORY_HOME_OVERRIDE = "/env-wins";
    expect(factoryConfigHome({ homeDir: "/explicit" })).toBe(path.join("/env-wins", ".factory"));
  });

  it("ignores blank and whitespace-only overrides", () => {
    process.env.CODEX_HOME = "   ";
    process.env.FACTORY_HOME_OVERRIDE = "";
    expect(codexConfigHome()).toBe(path.join(HOME, ".codex"));
    expect(factoryConfigHome()).toBe(path.join(HOME, ".factory"));
  });

  it("reads the env object it is given rather than the ambient process env", () => {
    process.env.CODEX_HOME = "/ambient";
    expect(codexConfigHome({ env: { CODEX_HOME: "/injected" } })).toBe("/injected");
    expect(codexConfigHome({ env: {} })).toBe(path.join(HOME, ".codex"));
  });
});
