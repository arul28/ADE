import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { expectedErrorKind, markExpected } from "../../../../desktop/src/shared/expectedError";
import { createProjectSecretService } from "../../../../desktop/src/main/services/secrets/projectSecretService";
import {
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_JWKS_URL,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  isClerkDevelopmentIssuer,
  isClerkDevelopmentOAuthClientId,
  officialAccountDirectoryUrlForIssuer,
  shouldIgnoreDevelopmentAccountDirectoryUrl,
  shouldIgnoreDevelopmentClerkConfiguration,
  warnDevelopmentClerkIgnored,
} from "../../../../desktop/src/shared/accountDirectory";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { createSyncCloudRelayStore } from "../sync/syncCloudRelayStore";
import {
  createAccountAuthService,
  type AccountAuthService,
  type AccountOAuthConfig,
  type AccountRefreshBroker,
} from "./accountAuthService";

export type AccountAttestationConfig = {
  issuer: string;
  jwksUrl: string;
  oauthClientId: string;
};

const sharedServices = new Map<string, AccountAuthService>();
const configProjectRoots = new Map<string, Set<string>>();

function rootsFor(secretsDir: string): Set<string> {
  const key = path.resolve(secretsDir);
  let roots = configProjectRoots.get(key);
  if (!roots) {
    roots = new Set<string>();
    configProjectRoots.set(key, roots);
  }
  return roots;
}

export function registerAccountConfigProjectRoot(
  projectRoot: string,
  secretsDir = resolveMachineAdeLayout().secretsDir,
  options: { prioritize?: boolean } = {},
): void {
  const normalized = projectRoot.trim();
  if (!normalized) return;
  const resolved = path.resolve(normalized);
  const key = path.resolve(secretsDir);
  const roots = rootsFor(secretsDir);
  if (!options.prioritize) {
    roots.add(resolved);
    return;
  }
  // `ade login` passes its invoking project root here so that project's CLERK_*
  // secrets win OAuth config resolution. resolveAccountOAuthConfig walks the set in
  // insertion order, so re-seat this root at the FRONT — otherwise a project
  // registered earlier (e.g. via registerAccountProjects) would shadow it in a
  // multi-project brain.
  if (roots.size === 0 || [...roots][0] === resolved) {
    roots.add(resolved);
    return;
  }
  const rest = [...roots].filter((root) => root !== resolved);
  configProjectRoots.set(key, new Set([resolved, ...rest]));
}

/**
 * Project folders that must not be read for account settings: those the brain
 * refused as too slow to open (`projectOpenStrikes.ts`). The settings live in
 * each registered project's own secrets and are read synchronously, on the
 * brain's thread, so a refused folder would freeze it again.
 *
 * A refused folder is answered from what was last read from it, never from
 * the defaults: falling back to ADE's own sign-in settings while a project's
 * custom ones are out of reach would refresh a session against the wrong
 * issuer (and so mark it signed out) or read the wrong machine directory. So
 * every read from a project is remembered, in this machine's secrets folder,
 * and a refused folder never read before makes the settings unavailable
 * (an error for that call) rather than defaulted.
 */
/**
 * The only names ever remembered on disk, in plain text: public identifiers
 * and URLs. Any other name is read as before, never remembered, and is
 * unavailable while its project is refused.
 */
const REMEMBERED_ACCOUNT_SETTING_NAMES: ReadonlySet<string> = new Set([
  "CLERK_ISSUER",
  "CLERK_OAUTH_CLIENT_ID",
  "CLERK_JWKS_URL",
  "ADE_ACCOUNT_DIRECTORY_URL",
]);

type AccountConfigRootGate = {
  skip: (projectRoot: string) => boolean;
  memoPath: string;
  memo: Map<string, Record<string, string | null>> | null;
};
let accountConfigRootGate: AccountConfigRootGate | null = null;

export function setAccountConfigRootSkip(skip: (projectRoot: string) => boolean, secretsDir: string): void {
  accountConfigRootGate = { skip, memoPath: path.join(secretsDir, "account-project-settings.json"), memo: null };
}

function accountConfigMemo(gate: AccountConfigRootGate): Map<string, Record<string, string | null>> {
  if (gate.memo) return gate.memo;
  gate.memo = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(gate.memoPath, "utf8")) as Record<string, unknown>;
    for (const [root, values] of Object.entries(parsed ?? {})) {
      if (!values || typeof values !== "object") continue;
      const entry: Record<string, string | null> = {};
      for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
        if (!REMEMBERED_ACCOUNT_SETTING_NAMES.has(name)) continue;
        if (typeof value === "string" || value === null) entry[name] = value;
      }
      gate.memo.set(root, entry);
    }
  } catch {
    // Missing or unreadable: nothing remembered yet.
  }
  return gate.memo;
}

function rememberProjectSecret(gate: AccountConfigRootGate, projectRoot: string, name: string, value: string | null): void {
  if (!REMEMBERED_ACCOUNT_SETTING_NAMES.has(name)) return;
  const memo = accountConfigMemo(gate);
  const entry = memo.get(projectRoot) ?? {};
  if (Object.prototype.hasOwnProperty.call(entry, name) && entry[name] === value) return;
  entry[name] = value;
  memo.set(projectRoot, entry);
  try {
    writeFileAtomic(gate.memoPath, `${JSON.stringify(Object.fromEntries(memo))}\n`, { mode: 0o600 });
  } catch {
    // Remembering is best-effort; the next read tries again.
  }
}

function readProjectSecret(projectRoot: string, name: string): string | null {
  const gate = accountConfigRootGate;
  if (gate?.skip(projectRoot)) {
    const remembered = REMEMBERED_ACCOUNT_SETTING_NAMES.has(name) ? accountConfigMemo(gate).get(projectRoot) : undefined;
    if (remembered && Object.prototype.hasOwnProperty.call(remembered, name)) return remembered[name] ?? null;
    throw markExpected(
      new Error("ADE can't read your account settings right now: a project's folder is too slow to open. Try again later."),
      "environment",
    );
  }
  let value: string | null;
  try {
    value = createProjectSecretService(projectRoot).get({ name }).value.trim() || null;
  } catch (error) {
    // The secret service answers "not set" with an expected `user` error;
    // anything else is a read that failed. Only a real answer is remembered,
    // so a failed read never replaces the last good one with "none".
    if (gate && expectedErrorKind(error) === "user") rememberProjectSecret(gate, projectRoot, name, null);
    return null;
  }
  if (gate) rememberProjectSecret(gate, projectRoot, name, value);
  return value;
}

function enforcePackagedOAuthConfig(
  env: NodeJS.ProcessEnv,
  config: AccountOAuthConfig,
): AccountOAuthConfig {
  if (
    !shouldIgnoreDevelopmentClerkConfiguration(env)
    || (!isClerkDevelopmentIssuer(config.issuer)
      && !isClerkDevelopmentOAuthClientId(config.clientId))
  ) {
    return config;
  }
  warnDevelopmentClerkIgnored();
  return {
    issuer: DEFAULT_ADE_CLERK_ISSUER,
    clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  };
}

function enforcePackagedAttestationConfig(
  env: NodeJS.ProcessEnv,
  config: AccountAttestationConfig,
): AccountAttestationConfig {
  if (
    !shouldIgnoreDevelopmentClerkConfiguration(env)
    || (!isClerkDevelopmentIssuer(config.issuer)
      && !isClerkDevelopmentIssuer(config.jwksUrl)
      && !isClerkDevelopmentOAuthClientId(config.oauthClientId))
  ) {
    return config;
  }
  warnDevelopmentClerkIgnored();
  return {
    issuer: DEFAULT_ADE_CLERK_ISSUER,
    jwksUrl: DEFAULT_ADE_CLERK_JWKS_URL,
    oauthClientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  };
}

export function resolveAccountOAuthConfig(args: {
  env: NodeJS.ProcessEnv;
  projectRoots: Iterable<string>;
}): AccountOAuthConfig {
  // Resolve issuer+clientId as an ATOMIC pair. The first project root that
  // yields either half wins the pair (filling only the missing half from env),
  // so we never combine an issuer from project A with a clientId from project B.
  for (const projectRoot of args.projectRoots) {
    const issuer = readProjectSecret(projectRoot, "CLERK_ISSUER");
    const clientId = readProjectSecret(projectRoot, "CLERK_OAUTH_CLIENT_ID");
    if (issuer || clientId) {
      return enforcePackagedOAuthConfig(args.env, {
        issuer: issuer ?? args.env.CLERK_ISSUER?.trim() ?? "",
        clientId: clientId ?? args.env.CLERK_OAUTH_CLIENT_ID?.trim() ?? "",
      });
    }
  }
  const issuer = args.env.CLERK_ISSUER?.trim() ?? "";
  const clientId = args.env.CLERK_OAUTH_CLIENT_ID?.trim() ?? "";
  // Environment overrides are another atomic pair: a partial custom pair must
  // fail closed rather than borrowing the missing half from ADE production.
  if (issuer || clientId) {
    return enforcePackagedOAuthConfig(args.env, { issuer, clientId });
  }
  return enforcePackagedOAuthConfig(args.env, {
    issuer: DEFAULT_ADE_CLERK_ISSUER,
    clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  });
}

export function resolveOfficialAccountDirectoryBaseUrl(args: {
  env: NodeJS.ProcessEnv;
  projectRoots: Iterable<string>;
}): string {
  return officialAccountDirectoryUrlForIssuer(resolveAccountOAuthConfig(args).issuer);
}

function resolveDeviceBridgeUrl(args: {
  env: NodeJS.ProcessEnv;
  projectRoots: Iterable<string>;
}): string {
  for (const projectRoot of args.projectRoots) {
    const value = readProjectSecret(projectRoot, "ADE_ACCOUNT_DIRECTORY_URL");
    if (value) {
      if (shouldIgnoreDevelopmentAccountDirectoryUrl(value, args.env)) {
        warnDevelopmentClerkIgnored();
        return resolveOfficialAccountDirectoryBaseUrl(args);
      }
      return value;
    }
  }
  const machineOverride = args.env.ADE_ACCOUNT_DIRECTORY_URL?.trim();
  if (machineOverride) {
    if (shouldIgnoreDevelopmentAccountDirectoryUrl(machineOverride, args.env)) {
      warnDevelopmentClerkIgnored();
      return resolveOfficialAccountDirectoryBaseUrl(args);
    }
    return machineOverride;
  }
  return resolveOfficialAccountDirectoryBaseUrl(args);
}

function resolveAttestationConfig(args: {
  env: NodeJS.ProcessEnv;
  projectRoots: Iterable<string>;
}): AccountAttestationConfig {
  // Keep all Clerk verification settings on the same atomic-resolution path as
  // account login. The first project that defines any CLERK_* value wins, with
  // only missing values filled from the daemon environment; values from two
  // different projects are never combined.
  for (const projectRoot of args.projectRoots) {
    const issuer = readProjectSecret(projectRoot, "CLERK_ISSUER");
    const jwksUrl = readProjectSecret(projectRoot, "CLERK_JWKS_URL");
    const oauthClientId = readProjectSecret(projectRoot, "CLERK_OAUTH_CLIENT_ID");
    if (issuer || jwksUrl || oauthClientId) {
      return enforcePackagedAttestationConfig(args.env, {
        issuer: issuer ?? args.env.CLERK_ISSUER?.trim() ?? "",
        jwksUrl: jwksUrl ?? args.env.CLERK_JWKS_URL?.trim() ?? "",
        oauthClientId: oauthClientId ?? args.env.CLERK_OAUTH_CLIENT_ID?.trim() ?? "",
      });
    }
  }
  const issuer = args.env.CLERK_ISSUER?.trim() ?? "";
  const jwksUrl = args.env.CLERK_JWKS_URL?.trim() ?? "";
  const oauthClientId = args.env.CLERK_OAUTH_CLIENT_ID?.trim() ?? "";
  if (issuer || jwksUrl || oauthClientId) {
    return enforcePackagedAttestationConfig(args.env, {
      issuer,
      jwksUrl,
      oauthClientId,
    });
  }
  return enforcePackagedAttestationConfig(args.env, {
    issuer: DEFAULT_ADE_CLERK_ISSUER,
    jwksUrl: DEFAULT_ADE_CLERK_JWKS_URL,
    oauthClientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  });
}

export function getSharedAccountAttestationConfig(args: {
  secretsDir?: string;
  projectRoots?: () => Iterable<string>;
  env?: NodeJS.ProcessEnv;
} = {}): AccountAttestationConfig {
  const secretsDir = path.resolve(args.secretsDir ?? resolveMachineAdeLayout().secretsDir);
  for (const projectRoot of args.projectRoots?.() ?? []) {
    registerAccountConfigProjectRoot(projectRoot, secretsDir);
  }
  return resolveAttestationConfig({
    env: args.env ?? process.env,
    projectRoots: rootsFor(secretsDir),
  });
}

export function getSharedAccountDirectoryBaseUrl(args: {
  secretsDir?: string;
  projectRoots?: () => Iterable<string>;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const secretsDir = path.resolve(args.secretsDir ?? resolveMachineAdeLayout().secretsDir);
  for (const projectRoot of args.projectRoots?.() ?? []) {
    registerAccountConfigProjectRoot(projectRoot, secretsDir);
  }
  return resolveDeviceBridgeUrl({
    env: args.env ?? process.env,
    projectRoots: rootsFor(secretsDir),
  });
}

/**
 * This machine's directory identity, read from the same file the brain's
 * account publisher reads. The machine key IS the directory's primary key for
 * this machine, so a pairing grant bound to anything else would be spendable on
 * the wrong row — or on nothing at all.
 *
 * Never throws: an unreadable identity costs the grant path, never the sign-in.
 */
function readMachineKey(secretsDir: string): string | null {
  try {
    return createSyncCloudRelayStore({
      filePath: path.join(secretsDir, "sync-cloud-relay.json"),
    }).getMachineIdentity().machineKey.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The process-wide refresh broker, or `null` when this process is the brain.
 *
 * Exactly one process on a machine may exchange the rotating refresh token.
 * The brain is that process. Every other one installs a broker here and asks
 * the brain instead, which is what removes the `invalid_grant` race by
 * construction rather than by timing. Today's installers:
 *   - desktop main, via `createBrainRefreshBroker` (accountBridge.ts), wired in
 *     `registerIpc.ts`;
 *   - every `ade …` command, via `installMachineBrainRefreshBroker` in `runCli`
 *     (cliRefreshBroker.ts) — except the `serve`/`runtime`/`brain` plans and
 *     `--headless`, which host the runtime rather than defer to it.
 * The installer puts a broker here even when no brain is listening. Its token
 * request probes the socket each time, so a brain started later is used while
 * a machine with no brain still safely keeps its local exchange.
 *
 * Deliberately module-level and late-bound: `getSharedAccountAuthService`
 * caches one service per secrets directory, so whoever asks first fixes that
 * service's options, and on desktop that can happen before the runtime pool
 * exists. Installing the broker separately means startup order cannot decide
 * whether a process refreshes locally.
 */
let sharedRefreshBroker: AccountRefreshBroker | null = null;

export function setSharedAccountRefreshBroker(broker: AccountRefreshBroker | null): void {
  sharedRefreshBroker = broker;
}

export function getSharedAccountRefreshBroker(): AccountRefreshBroker | null {
  return sharedRefreshBroker;
}

export function getSharedAccountAuthService(args: {
  secretsDir?: string;
  projectRoots?: () => Iterable<string>;
  env?: NodeJS.ProcessEnv;
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
} = {}): AccountAuthService {
  const secretsDir = path.resolve(args.secretsDir ?? resolveMachineAdeLayout().secretsDir);
  for (const projectRoot of args.projectRoots?.() ?? []) {
    registerAccountConfigProjectRoot(projectRoot, secretsDir);
  }
  const existing = sharedServices.get(secretsDir);
  if (existing) return existing;

  const service = createAccountAuthService({
    credentialStore: new EncryptedFileCredentialStore({ secretsDir }),
    getOAuthConfig: () => resolveAccountOAuthConfig({
      env: args.env ?? process.env,
      projectRoots: rootsFor(secretsDir),
    }),
    getDeviceBridgeUrl: () => getSharedAccountDirectoryBaseUrl({
      secretsDir,
      env: args.env,
    }),
    getMachineKey: () => readMachineKey(secretsDir),
    // Loaded lazily: both modules are large, and only a sign-in needs them.
    getMachineName: async () => {
      const [{ resolveDeviceDisplayNameSettled }, { publishedMachineName }] = await Promise.all([
        import("../sync/deviceRegistryService"),
        import("./accountMachinePublisherService"),
      ]);
      const env = args.env ?? process.env;
      return publishedMachineName(await resolveDeviceDisplayNameSettled(), env.ADE_PACKAGE_CHANNEL);
    },
    getRefreshBroker: () => sharedRefreshBroker,
    env: args.env ?? process.env,
    logger: args.logger,
  });
  sharedServices.set(secretsDir, service);
  return service;
}
