import path from "node:path";
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
import {
  createAccountAuthService,
  type AccountAuthService,
  type AccountOAuthConfig,
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

function readProjectSecret(projectRoot: string, name: string): string | null {
  try {
    return createProjectSecretService(projectRoot).get({ name }).value.trim() || null;
  } catch {
    return null;
  }
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
    env: args.env ?? process.env,
    logger: args.logger,
  });
  sharedServices.set(secretsDir, service);
  return service;
}
