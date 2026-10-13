import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentConfigError,
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  parseJsonc,
  verifyDevicePage,
  verifyDirectoryDeploymentConfig,
  wranglerSecretListInvocation,
  wranglerSecretNames,
} from "../scripts/verify-deployment-config.mjs";

const wranglerConfigPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "wrangler.jsonc",
);

const completeVars = {
  PUSH_RELAY_URL: "https://relay.test",
  WEB_CLIENT_ORIGIN: "https://app.test",
  ONLINE_WINDOW_MS: "90000",
  DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "400",
  USAGE_RESEARCH_DAILY_GLOBAL_LIMIT: "20000",
  USAGE_RESEARCH_RETENTION_DAYS: "180",
  USAGE_RESEARCH_STORAGE_CEILING_MB: "4096",
  MODEL_REGISTRY_REFRESH: "1",
};

const relayBinding = [{ binding: "ACTIVITY_RELAY", service: "ade-push-relay" }];

const completeConfig = {
  vars: completeVars,
  services: relayBinding,
  env: { production: { vars: completeVars, services: relayBinding } },
};

/** Every secret a fully set-up environment holds: the required ones and the optional ones. */
const allSecrets = [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS.map(({ name }) => name)];

function verify(args: {
  environments?: string[];
  secretsByEnvironment?: Record<string, string[]>;
  config?: unknown;
}): { warnings: string[]; devicePageOrigins: Array<{ environment: string; origin: string }> } {
  return verifyDirectoryDeploymentConfig({
    environments: args.environments,
    listSecretNames: (environment) =>
      args.secretsByEnvironment?.[environment] ?? allSecrets,
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
          default: [...REQUIRED_SECRETS],
          production: ["CLERK_ISSUER"],
        },
      })
    ).toThrow(/production environment: DIRECTORY_AUTH_SECRET/);
  });

  it("does not require the unused default environment for a production deploy", () => {
    expect(() => verify({
      environments: ["production"],
      secretsByEnvironment: { default: [], production: [...REQUIRED_SECRETS] },
    })).not.toThrow();
  });

  it.each(["CLERK_JWKS_URL", "CLERK_ISSUER", "CLERK_OAUTH_CLIENT_ID"])(
    "fails when %s is not bound",
    (missing) => {
      // `resolveCallerToken` throws "authentication unavailable" when any of the
      // trio is blank: every authenticated route answers 503 and the whole
      // /device/* sign-in flow breaks, while /health stays green.
      const secrets = REQUIRED_SECRETS.filter((name) => name !== missing);
      expect(() =>
        verify({ secretsByEnvironment: { default: secrets, production: secrets } })
      ).toThrow(new RegExp(`default environment: ${missing}`));
    },
  );

  it("names every missing secret at once", () => {
    expect(() => verify({ secretsByEnvironment: { default: ["DIRECTORY_AUTH_SECRET"] } }))
      .toThrow(/CLERK_JWKS_URL, CLERK_ISSUER, CLERK_OAUTH_CLIENT_ID/);
  });

  it("rejects an unknown deployment environment", () => {
    expect(() => verify({ environments: ["staging"] }))
      .toThrow(/unknown Worker environment\(s\): staging/);
  });

  it.each([
    [
      "the default environment",
      { vars: {}, env: { production: { vars: completeVars } } },
      /default environment: PUSH_RELAY_URL/,
    ],
    [
      "the production environment",
      { vars: completeVars, services: relayBinding, env: {} },
      /production environment: PUSH_RELAY_URL/,
    ],
    [
      "an empty value",
      { vars: { ...completeVars, PUSH_RELAY_URL: "   " }, env: { production: { vars: completeVars } } },
      /default environment: PUSH_RELAY_URL/,
    ],
  ])("fails when PUSH_RELAY_URL is missing from %s", (_label, config, expected) => {
    expect(() => verify({ config })).toThrow(expected as RegExp);
  });

  it.each([
    ["the default environment", { vars: completeVars, env: { production: { vars: completeVars, services: relayBinding } } }, /default environment: ACTIVITY_RELAY/],
    // Environments do not inherit bindings: a top-level binding alone left
    // production calling the relay through workers.dev, which Cloudflare
    // answers with a 404 the relay never sees.
    ["production", { vars: completeVars, services: relayBinding, env: { production: { vars: completeVars } } }, /production environment: ACTIVITY_RELAY/],
  ])("regression: fails when the ACTIVITY_RELAY service binding is missing from %s", (_label, config, expected) => {
    expect(() => verify({ config })).toThrow(expected);
  });

  it("fails when WEB_CLIENT_ORIGIN is missing", () => {
    // No code default: without it the Worker emits no
    // access-control-allow-origin, so the browser client is blocked outright.
    const vars = { ...completeVars, WEB_CLIENT_ORIGIN: "" };
    expect(() => verify({ config: { vars, services: relayBinding, env: { production: { vars, services: relayBinding } } } }))
      .toThrow(/default environment: WEB_CLIENT_ORIGIN/);
  });

  it("warns instead of failing for vars that have code defaults", () => {
    // DIAGNOSTICS_DAILY_GLOBAL_LIMIT falls back to 400 and ONLINE_WINDOW_MS to
    // 90000, both equal to the committed values, so their absence changes no
    // behavior — the diagnostics cost ceiling still applies. Blocking a deploy
    // on them would be a false gate.
    const vars = {
      PUSH_RELAY_URL: "https://relay.test",
      WEB_CLIENT_ORIGIN: "https://app.test",
    };
    const result = verify({ config: { vars, services: relayBinding, env: { production: { vars, services: relayBinding } } } });
    expect(result.warnings).toEqual(["default", "production"].flatMap((environment) => [
      "ONLINE_WINDOW_MS",
      "DIAGNOSTICS_DAILY_GLOBAL_LIMIT",
      "USAGE_RESEARCH_DAILY_GLOBAL_LIMIT",
      "USAGE_RESEARCH_RETENTION_DAYS",
      "USAGE_RESEARCH_STORAGE_CEILING_MB",
      "MODEL_REGISTRY_REFRESH",
    ].map((name) => expect.stringContaining(`${name} is not set for the ${environment} environment`))));
  });

  it("warns when a defaulted var is set to something the Worker cannot parse", () => {
    // Number("unlimited") is NaN, so the Worker silently uses 400 while the
    // config reads as configured.
    const vars = { ...completeVars, DIAGNOSTICS_DAILY_GLOBAL_LIMIT: "unlimited" };
    const result = verify({ environments: ["production"], config: { vars, services: relayBinding, env: { production: { vars, services: relayBinding } } } });
    expect(result.warnings).toEqual([
      expect.stringContaining("DIAGNOSTICS_DAILY_GLOBAL_LIMIT for the production environment is not a non-negative number"),
    ]);
  });

  it("accepts the committed wrangler.jsonc with no warnings, and names the sign-in page a production deploy must find live", () => {
    const config = parseJsonc(readFileSync(wranglerConfigPath, "utf8"));
    const result = verify({ config });
    expect(result.warnings).toEqual([]);
    // Production hands out sign-in links on the website, so the deploy has to
    // check that page first. The default environment keeps the Worker's own.
    expect(result.devicePageOrigins).toEqual([
      { environment: "production", origin: "https://ade-app.dev" },
    ]);
  });

  it("warns, and does not fail, when the phone-approval key is missing", () => {
    // Without CLERK_SECRET_KEY only `/device/approve` is off (503), and the
    // browser page still signs people in. Blocking a deploy on it would be a
    // false gate; saying nothing would hide why phone approval does not work.
    const result = verify({
      environments: ["production"],
      secretsByEnvironment: { production: [...REQUIRED_SECRETS] },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("CLERK_SECRET_KEY is not set for the production environment");
    expect(result.devicePageOrigins).toEqual([]);
  });

  it.each([
    ["a path", "https://ade-app.dev/device"],
    ["a trailing slash", "https://ade-app.dev/"],
    ["a query", "https://ade-app.dev?x=1"],
    ["plain http", "http://ade-app.dev"],
    ["not a URL", "ade-app.dev"],
  ])("fails when DEVICE_PAGE_ORIGIN is not an exact https origin (%s)", (_label, value) => {
    // The Worker ignores such a value without saying so and hands out links on
    // its own host, so the mistake would only show up as "the QR code does not
    // open the app".
    const vars = { ...completeVars, DEVICE_PAGE_ORIGIN: value };
    const config = { vars: completeVars, services: relayBinding, env: { production: { vars, services: relayBinding } } };
    expect(() => verify({ environments: ["production"], config })).toThrow(DeploymentConfigError);
    expect(() => verify({ environments: ["production"], config })).toThrow(/DEVICE_PAGE_ORIGIN for the production environment/);
    // The default environment does not set it, so it is not affected.
    expect(verify({ environments: ["default"], config }).devicePageOrigins).toEqual([]);
  });
});

describe("sign-in page check", () => {
  const worker = "https://directory.example.workers.dev/device?user_code=ABCD-EFGH";
  const www = "https://www.ade-app.dev/device?user_code=ABCD-EFGH";

  /** Answers each request in turn with a status and an optional Location. */
  function site(steps: Array<[number, string | null] | Error>): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    let index = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return new Response(null, { status: step[0], headers: step[1] ? { location: step[1] } : {} });
    }) as typeof fetch;
    return { fetchImpl, urls };
  }

  it.each([
    ["redirects straight to the sign-in page", [[302, worker]]],
    // The live site sends every path from the bare host to `www` first.
    ["redirects through its own www host first", [[307, www], [302, worker]]],
  ] as Array<[string, Array<[number, string | null]>]>)("passes a website that %s", async (_label, steps) => {
    const { fetchImpl, urls } = site(steps);
    await expect(verifyDevicePage("https://ade-app.dev", fetchImpl)).resolves.toBeUndefined();
    expect(urls[0]).toBe("https://ade-app.dev/device?user_code=ABCD-EFGH");
    expect(urls).toHaveLength(steps.length);
  });

  it.each([
    // The state of the live site before `/device` is deployed: the hop to
    // `www` happens for every path, and then the page is the app shell.
    ["only hops to its own www host and then serves a page", [[307, www], [200, null]]],
    ["serves a page", [[200, null]]],
    ["answers 404", [[404, null]]],
    ["drops the code", [[302, "https://directory.example.workers.dev/device"]]],
    ["redirects to another path", [[302, "https://directory.example.workers.dev/sign-in?user_code=ABCD-EFGH"]]],
    ["redirects to plain http", [[302, "http://directory.example.workers.dev/device?user_code=ABCD-EFGH"]]],
    ["redirects to itself forever", [[307, www]]],
    ["cannot be reached", [new Error("getaddrinfo ENOTFOUND")]],
  ] as Array<[string, Array<[number, string | null] | Error>]>)("refuses a website that %s", async (_label, steps) => {
    const { fetchImpl, urls } = site(steps);
    await expect(verifyDevicePage("https://ade-app.dev", fetchImpl)).rejects.toBeInstanceOf(DeploymentConfigError);
    // Bounded: a redirect loop inside the site cannot hang a deploy.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.length).toBeLessThanOrEqual(4);
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
