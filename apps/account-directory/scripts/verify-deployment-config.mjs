import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Deploy preflight for the directory's half of the machine-membership contract.
 *
 * The relay already refuses to deploy without `DIRECTORY_AUTH_SECRET`
 * (`apps/push-relay/scripts/verify-deployment-auth.mjs`), but the directory is
 * where its absence actually bites: `callActivityRelay` fails closed with
 * "directory relay authentication is not configured", so in an environment
 * missing either half EVERY machine removal answers 502 and every re-pair 503.
 * `PUSH_RELAY_URL` is asserted alongside it because it fails the same way — the
 * relay hand-off has no URL to call. The `ACTIVITY_RELAY` service binding is
 * asserted too: it is the transport, and without it the call goes through
 * workers.dev, where Cloudflare refuses a same-account Worker-to-Worker fetch
 * with a 404 (error 1042) that the relay never sees. That is how every re-pair
 * answered 503 in production until 2026-09-23.
 *
 * The Clerk trio is checked for exactly the same reason, one failure shape
 * further in: `resolveCallerToken` throws "authentication unavailable" when any
 * of `CLERK_JWKS_URL` / `CLERK_ISSUER` / `CLERK_OAUTH_CLIENT_ID` is blank, so a
 * deploy missing one answers 503 on EVERY authenticated route and on the whole
 * `/device/*` sign-in flow — while `/health` stays green, which is precisely the
 * shape of the 2026-08-06 incident this preflight exists to prevent.
 * `WEB_CLIENT_ORIGIN` earns a hard failure too: it has no code default, and
 * without it no `access-control-allow-origin` is emitted, so the browser client
 * at app.ade-app.dev is blocked outright.
 *
 * `ONLINE_WINDOW_MS`, `DIAGNOSTICS_DAILY_GLOBAL_LIMIT`, the three
 * `USAGE_RESEARCH_*` bounds and `MODEL_REGISTRY_REFRESH` are deliberately NOT
 * hard requirements: each has a code default equal to the committed value
 * (`DEFAULT_ONLINE_WINDOW_MS` = 90_000, `DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT`
 * = 400, 20000 writes/day, 180 days and 4096 MB in `src/usageResearch.ts`, and
 * refresh on in `src/modelRegistry.ts`), so their absence changes no behavior —
 * every cost ceiling still applies. Blocking a deploy on them would
 * be a false gate.
 * They warn instead, including when they are set to something the Worker cannot
 * parse, because that silently falls back to the default rather than erroring.
 *
 * `DEVICE_PAGE_ORIGIN` moves every sign-in link the Worker hands out to another
 * site (`https://ade-app.dev/device`), so that site is checked live before the
 * deploy: it must already redirect `/device` to a `/device` page elsewhere and
 * keep the code. A Worker published ahead of the website turns every sign-in
 * link, including the ones older CLIs print, into a 404. A value the Worker
 * cannot use (a path, a query, plain http) fails too, because the Worker would
 * ignore it without saying so. `CLERK_SECRET_KEY` only warns: without it the
 * phone approval route answers 503 and the browser page still works.
 *
 * Secrets are read from `wrangler secret list` BY NAME ONLY — this never reads,
 * prints, or logs a secret value. Vars are read from the committed
 * `wrangler.jsonc`. The deploy entry point passes the exact environment it is
 * about to publish: wrangler environments inherit neither vars nor secrets, and
 * a production deploy must not be blocked by an unrelated local development
 * environment that is intentionally unconfigured.
 */

export const REQUIRED_SECRETS = [
  "DIRECTORY_AUTH_SECRET",
  "CLERK_JWKS_URL",
  "CLERK_ISSUER",
  "CLERK_OAUTH_CLIENT_ID",
];
export const REQUIRED_VARS = ["PUSH_RELAY_URL", "WEB_CLIENT_ORIGIN"];
export const REQUIRED_SERVICE_BINDINGS = [{ binding: "ACTIVITY_RELAY", service: "ade-push-relay" }];
/** Have code defaults: missing (or unparseable) is a warning, never a failure. */
export const DEFAULTED_VARS = [
  { name: "ONLINE_WINDOW_MS", codeDefault: "90000" },
  { name: "DIAGNOSTICS_DAILY_GLOBAL_LIMIT", codeDefault: "400" },
  { name: "USAGE_RESEARCH_DAILY_GLOBAL_LIMIT", codeDefault: "20000" },
  { name: "USAGE_RESEARCH_RETENTION_DAYS", codeDefault: "180" },
  { name: "USAGE_RESEARCH_STORAGE_CEILING_MB", codeDefault: "4096" },
  { name: "MODEL_REGISTRY_REFRESH", codeDefault: "1" },
];
/** Optional: missing only turns one route off, so it is a warning. */
export const OPTIONAL_SECRETS = [
  {
    name: "CLERK_SECRET_KEY",
    effect: "approving a sign-in from the ADE phone app answers 503, and the app offers the browser page",
  },
];
export const ENVIRONMENTS = ["default", "production"];
/** A well-formed code that no sign-in holds; the page must carry it through. */
const DEVICE_PAGE_PROBE_CODE = "ABCD-EFGH";

export class DeploymentConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentConfigError";
  }
}

/** Minimal JSONC reader: wrangler configs carry `//` comments, JSON.parse does not. */
export function parseJsonc(source) {
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      stripped += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      stripped += character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      stripped += "\n";
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    stripped += character;
  }
  // Trailing commas are legal in wrangler.jsonc and fatal to JSON.parse.
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
}

/** The wrangler section an environment deploys from: `env.production`, or the top level. */
function environmentSection(config, environment) {
  return (environment === "production" ? config?.env?.production : config) ?? {};
}

/**
 * @param {object} args
 * @param {(environment: string) => Iterable<string>} args.listSecretNames
 * @param {() => object} args.readConfig
 * @returns {{ warnings: string[], devicePageOrigins: { environment: string, origin: string }[] }}
 *   Non-blocking notes, and the sign-in pages `verifyDevicePage` must find live.
 */
export function verifyDirectoryDeploymentConfig(args) {
  const environments = args.environments ?? ENVIRONMENTS;
  const unknownEnvironments = environments.filter(
    (environment) => !ENVIRONMENTS.includes(environment),
  );
  if (unknownEnvironments.length > 0) {
    throw new DeploymentConfigError(
      `unknown Worker environment(s): ${unknownEnvironments.join(", ")}`,
    );
  }
  const optionalSecretWarnings = [];
  for (const environment of environments) {
    const secretNames = new Set(args.listSecretNames(environment));
    const missingSecrets = REQUIRED_SECRETS.filter((name) => !secretNames.has(name));
    if (missingSecrets.length > 0) {
      throw new DeploymentConfigError(
        `missing Worker secret bindings for the ${environment} environment: ${missingSecrets.join(", ")}`,
      );
    }
    for (const { name, effect } of OPTIONAL_SECRETS) {
      if (!secretNames.has(name)) {
        optionalSecretWarnings.push(`${name} is not set for the ${environment} environment; ${effect}.`);
      }
    }
  }
  const config = args.readConfig();
  const warnings = [...optionalSecretWarnings];
  const devicePageOrigins = [];
  for (const environment of environments) {
    const section = environmentSection(config, environment);
    const vars = section.vars && typeof section.vars === "object" ? section.vars : {};
    const missingVars = REQUIRED_VARS.filter((name) => !isConfiguredVar(vars[name]));
    if (missingVars.length > 0) {
      throw new DeploymentConfigError(
        `missing Worker vars for the ${environment} environment: ${missingVars.join(", ")}`,
      );
    }
    const services = Array.isArray(section.services) ? section.services : [];
    const missingServices = REQUIRED_SERVICE_BINDINGS.filter(
      ({ binding, service }) => !services.some((entry) => entry?.binding === binding && entry?.service === service),
    );
    if (missingServices.length > 0) {
      throw new DeploymentConfigError(
        `missing Worker service bindings for the ${environment} environment: ${missingServices.map(({ binding, service }) => `${binding} → ${service}`).join(", ")}`,
      );
    }
    if (isConfiguredVar(vars.DEVICE_PAGE_ORIGIN)) {
      const origin = exactHttpsOrigin(vars.DEVICE_PAGE_ORIGIN);
      if (!origin) {
        throw new DeploymentConfigError(
          `DEVICE_PAGE_ORIGIN for the ${environment} environment must be an https origin with no path or query; the Worker would ignore "${vars.DEVICE_PAGE_ORIGIN}"`,
        );
      }
      devicePageOrigins.push({ environment, origin });
    }
    for (const { name, codeDefault } of DEFAULTED_VARS) {
      if (!isConfiguredVar(vars[name])) {
        warnings.push(
          `${name} is not set for the ${environment} environment; the Worker will use its code default of ${codeDefault}.`,
        );
      } else if (!isNonNegativeNumber(vars[name])) {
        // The Worker parses these with Number() and silently falls back, so a
        // typo here reads as "configured" while doing nothing.
        warnings.push(
          `${name} for the ${environment} environment is not a non-negative number; the Worker will ignore it and use ${codeDefault}.`,
        );
      }
    }
  }
  return { warnings, devicePageOrigins };
}

function exactHttpsOrigin(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.origin === value.trim() ? url.origin : null;
  } catch {
    return null;
  }
}

/** `ade-app.dev` and `www.ade-app.dev` are one site; the apex redirects to `www`. */
function sameSite(left, right) {
  const bare = (host) => host.replace(/^www\./, "");
  return bare(left.hostname) === bare(right.hostname);
}

/**
 * Is the sign-in page at `origin` live? `/device` must redirect to a `/device`
 * page on another site and keep the code. A hop inside the site (the apex to
 * `www`) is followed first, because that hop alone proves nothing: the site
 * makes it for every path, deployed or not.
 *
 * @param {string} origin
 * @param {typeof fetch} [fetchImpl]
 */
export async function verifyDevicePage(origin, fetchImpl = fetch) {
  const start = new URL(`${origin}/device?user_code=${DEVICE_PAGE_PROBE_CODE}`);
  let current = start;
  let status = 0;
  for (let hop = 0; hop < 4; hop += 1) {
    let response;
    try {
      response = await fetchImpl(current.href, { redirect: "manual" });
    } catch {
      throw new DeploymentConfigError(
        `${current.origin}/device could not be reached, so the sign-in page could not be checked; check the network, and that the website is deployed`,
      );
    }
    status = response.status;
    let target = null;
    try {
      target = new URL(response.headers.get("location") ?? "", current);
    } catch {
      // No usable Location: reported below with the status.
    }
    if (status < 300 || status >= 400 || !target || target.protocol !== "https:") break;
    if (sameSite(target, start)) {
      current = target;
      continue;
    }
    if (target.pathname === "/device" && target.searchParams.get("user_code") === DEVICE_PAGE_PROBE_CODE) return;
    break;
  }
  throw new DeploymentConfigError(
    `${current.origin}/device answered ${status} and does not redirect to a sign-in page; deploy the website first, or every sign-in link is a dead end`,
  );
}

function isConfiguredVar(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function isNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

/**
 * How to spawn `wrangler secret list` on this platform.
 *
 * Windows has no `npx` executable, only `npx.cmd`, and since Node's `.bat`/
 * `.cmd` spawn hardening (18.20.2 / 20.12.2 / 21.7.3) spawning a `.cmd` WITHOUT
 * a shell throws `EINVAL`. Uncaught, that lands in the catch below and reports
 * "could not read the deployed Worker secret bindings" — so `npm run deploy`
 * would be unconditionally blocked on Windows with a message pointing at the
 * wrong problem. Every argument here is a fixed literal with no spaces or shell
 * metacharacters, so `shell: true` introduces no quoting hazard.
 *
 * `windowsHide` keeps the shell from flashing a console window on Windows.
 *
 * @param {string} environment
 * @param {NodeJS.Platform} [platform]
 */
export function wranglerSecretListInvocation(environment, platform = process.platform) {
  const windows = platform === "win32";
  return {
    command: windows ? "npx.cmd" : "npx",
    args: [
      "wrangler",
      "secret",
      "list",
      "--format",
      "json",
      ...(environment === "production" ? ["--env", "production"] : []),
    ],
    options: {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
      ...(windows ? { shell: true } : {}),
    },
  };
}

/**
 * @param {string} environment
 * @param {object} [overrides] Injection seam for tests; production uses the defaults.
 * @param {NodeJS.Platform} [overrides.platform]
 * @param {typeof execFileSync} [overrides.exec]
 */
export function wranglerSecretNames(environment, overrides = {}) {
  const { platform = process.platform, exec = execFileSync } = overrides;
  const invocation = wranglerSecretListInvocation(environment, platform);
  let output;
  try {
    output = exec(invocation.command, invocation.args, invocation.options);
  } catch {
    throw new DeploymentConfigError(
      `could not read the deployed Worker secret bindings for the ${environment} environment`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new DeploymentConfigError(
      `Wrangler returned an unreadable secret list for the ${environment} environment`,
    );
  }
  return (Array.isArray(parsed) ? parsed : [])
    .map((entry) => (typeof entry?.name === "string" ? entry.name : ""))
    .filter(Boolean);
}

async function main() {
  const requestedEnvironment = process.argv[2];
  const environments = requestedEnvironment ? [requestedEnvironment] : ENVIRONMENTS;
  const configPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "wrangler.jsonc",
  );
  let warnings = [];
  try {
    const result = verifyDirectoryDeploymentConfig({
      environments,
      listSecretNames: wranglerSecretNames,
      readConfig: () => parseJsonc(readFileSync(configPath, "utf8")),
    });
    warnings = result.warnings;
    for (const { origin } of result.devicePageOrigins) await verifyDevicePage(origin);
  } catch (error) {
    console.error(
      `Account directory deployment preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
  for (const warning of warnings) console.warn(`Account directory deployment preflight: ${warning}`);
  console.log(
    `Account directory authentication and relay hand-off configuration is complete for the ${environments.join(" and ")} environment${environments.length === 1 ? "" : "s"}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
