import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOME = "/home/tester";

// Both `localUsageLedgers` and the `providerConfigHomes` helper it reads through
// take `homedir` as a named import, so a spy on the default export would not
// intercept it. Mock the module instead.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal() as object),
  homedir: () => HOME,
}));

const { defaultDroidSessionsDir } = await import("./localUsageLedgers");

const ENV_KEYS = ["FACTORY_DIR", "FACTORY_HOME_OVERRIDE"] as const;

describe("defaultDroidSessionsDir", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults to ~/.factory/sessions", () => {
    expect(defaultDroidSessionsDir()).toBe(path.join(HOME, ".factory", "sessions"));
  });

  it("honours FACTORY_HOME_OVERRIDE the same way the Droid launcher does", () => {
    process.env.FACTORY_HOME_OVERRIDE = "/accounts/two";
    expect(defaultDroidSessionsDir()).toBe(path.join("/accounts/two", ".factory", "sessions"));
  });

  it("still honours the legacy FACTORY_DIR when the provider override is absent", () => {
    process.env.FACTORY_DIR = "/legacy/factory";
    expect(defaultDroidSessionsDir()).toBe(path.join("/legacy/factory", "sessions"));
  });

  it("prefers FACTORY_HOME_OVERRIDE over the legacy FACTORY_DIR", () => {
    process.env.FACTORY_DIR = "/legacy/factory";
    process.env.FACTORY_HOME_OVERRIDE = "/accounts/two";
    expect(defaultDroidSessionsDir()).toBe(path.join("/accounts/two", ".factory", "sessions"));
  });
});
