import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentConfigError,
  parseJsonc,
  verifyDirectoryDeploymentConfig,
  wranglerSecretListInvocation,
  wranglerSecretNames,
} from "../scripts/verify-deployment-config.mjs";

const wranglerConfigPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "wrangler.jsonc",
);

const completeConfig = {
  vars: { PUSH_RELAY_URL: "https://relay.test" },
  env: { production: { vars: { PUSH_RELAY_URL: "https://relay.test" } } },
};

function verify(args: {
  environments?: string[];
  secretsByEnvironment?: Record<string, string[]>;
  config?: unknown;
}): void {
  verifyDirectoryDeploymentConfig({
    environments: args.environments,
    listSecretNames: (environment) =>
      args.secretsByEnvironment?.[environment] ?? ["DIRECTORY_AUTH_SECRET"],
    readConfig: () => args.config ?? completeConfig,
  });
}

describe("account directory deployment preflight", () => {
  it("passes when both halves of the relay hand-off are configured everywhere", () => {
    expect(() => verify({})).not.toThrow();
  });

  it("fails when DIRECTORY_AUTH_SECRET is missing from the default environment", () => {
    // Without it `callActivityRelay` fails closed, so every machine removal
    // answers 502 and every re-pair 503 — a deploy must never reach that state.
    expect(() => verify({ secretsByEnvironment: { default: [] } }))
      .toThrow(DeploymentConfigError);
    expect(() => verify({ secretsByEnvironment: { default: [] } }))
      .toThrow(/DIRECTORY_AUTH_SECRET/);
  });

  it("fails when only production is missing the secret", () => {
    // Wrangler environments do not inherit secrets, so production is its own
    // failure mode and the default environment passing proves nothing.
    expect(() =>
      verify({
        secretsByEnvironment: {
          default: ["DIRECTORY_AUTH_SECRET"],
          production: ["CLERK_ISSUER"],
        },
      })
    ).toThrow(/production environment: DIRECTORY_AUTH_SECRET/);
  });

  it("does not require the unused default environment for a production deploy", () => {
    expect(() => verify({
      environments: ["production"],
      secretsByEnvironment: { default: [], production: ["DIRECTORY_AUTH_SECRET"] },
    })).not.toThrow();
  });

  it("rejects an unknown deployment environment", () => {
    expect(() => verify({ environments: ["staging"] }))
      .toThrow(/unknown Worker environment\(s\): staging/);
  });

  it.each([
    [
      "the default environment",
      { vars: {}, env: { production: { vars: { PUSH_RELAY_URL: "https://relay.test" } } } },
      /default environment: PUSH_RELAY_URL/,
    ],
    [
      "the production environment",
      { vars: { PUSH_RELAY_URL: "https://relay.test" }, env: {} },
      /production environment: PUSH_RELAY_URL/,
    ],
    [
      "an empty value",
      { vars: { PUSH_RELAY_URL: "   " }, env: { production: { vars: { PUSH_RELAY_URL: "https://relay.test" } } } },
      /default environment: PUSH_RELAY_URL/,
    ],
  ])("fails when PUSH_RELAY_URL is missing from %s", (_label, config, expected) => {
    expect(() => verify({ config })).toThrow(expected as RegExp);
  });

  it("accepts the committed wrangler.jsonc", () => {
    const config = parseJsonc(readFileSync(wranglerConfigPath, "utf8"));
    expect(() => verify({ config })).not.toThrow();
  });
});

describe("wrangler secret list invocation", () => {
  it("spawns npx.cmd through a shell on win32", () => {
    // Windows has no bare `npx`, and since Node's .bat/.cmd spawn hardening
    // (18.20.2 / 20.12.2 / 21.7.3) spawning a `.cmd` without a shell throws
    // EINVAL — which this script would report as "could not read the deployed
    // Worker secret bindings", blocking `npm run deploy` on Windows entirely.
    const invocation = wranglerSecretListInvocation("default", "win32");
    expect(invocation.command).toBe("npx.cmd");
    expect(invocation.options).toMatchObject({ shell: true, windowsHide: true });
  });

  it("spawns bare npx without a shell elsewhere", () => {
    const invocation = wranglerSecretListInvocation("default", "darwin");
    expect(invocation.command).toBe("npx");
    expect(invocation.options.shell).toBeUndefined();
    expect(invocation.options).toMatchObject({ windowsHide: true });
  });

  it("targets the named environment only for production", () => {
    expect(wranglerSecretListInvocation("default", "win32").args)
      .toEqual(["wrangler", "secret", "list", "--format", "json"]);
    expect(wranglerSecretListInvocation("production", "win32").args)
      .toEqual(["wrangler", "secret", "list", "--format", "json", "--env", "production"]);
  });

  it("really spawns a process with the win32 option set", () => {
    // The regression is an option object Node refuses to spawn with, so prove
    // it round-trips through the real execFileSync rather than only asserting
    // its shape. `shell: true` is honored on every platform, so this exercises
    // the win32 branch's options wherever the suite runs.
    const { options } = wranglerSecretListInvocation("default", "win32");
    const output = execFileSync("node", ["--version"], options);
    expect(String(output).trim()).toMatch(/^v\d+\./);
  });

  it("reads secret names from the spawned wrangler output", () => {
    const exec = vi.fn(() => JSON.stringify([{ name: "DIRECTORY_AUTH_SECRET" }, {}]));
    expect(wranglerSecretNames("production", { platform: "win32", exec }))
      .toEqual(["DIRECTORY_AUTH_SECRET"]);
    expect(exec).toHaveBeenCalledWith(
      "npx.cmd",
      ["wrangler", "secret", "list", "--format", "json", "--env", "production"],
      expect.objectContaining({ shell: true, windowsHide: true }),
    );
  });

  it("reports a spawn failure as a deployment config error", () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error("spawn npx.cmd EINVAL"), { code: "EINVAL" });
    });
    expect(() => wranglerSecretNames("default", { platform: "win32", exec }))
      .toThrow(DeploymentConfigError);
  });
});
