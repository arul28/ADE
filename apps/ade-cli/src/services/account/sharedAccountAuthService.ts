import path from "node:path";
import { createProjectSecretService } from "../../../../desktop/src/main/services/secrets/projectSecretService";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import {
  createAccountAuthService,
  type AccountAuthService,
  type AccountOAuthConfig,
} from "./accountAuthService";

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
): void {
  const normalized = projectRoot.trim();
  if (!normalized) return;
  rootsFor(secretsDir).add(path.resolve(normalized));
}

function readProjectSecret(projectRoot: string, name: string): string | null {
  try {
    return createProjectSecretService(projectRoot).get({ name }).value.trim() || null;
  } catch {
    return null;
  }
}

function resolveOAuthConfig(args: {
  env: NodeJS.ProcessEnv;
  projectRoots: Iterable<string>;
}): AccountOAuthConfig {
  let issuer: string | null = null;
  let clientId: string | null = null;
  for (const projectRoot of args.projectRoots) {
    issuer ??= readProjectSecret(projectRoot, "CLERK_ISSUER");
    clientId ??= readProjectSecret(projectRoot, "CLERK_OAUTH_CLIENT_ID");
    if (issuer && clientId) break;
  }
  issuer ??= args.env.CLERK_ISSUER?.trim() || null;
  clientId ??= args.env.CLERK_OAUTH_CLIENT_ID?.trim() || null;
  return { issuer: issuer ?? "", clientId: clientId ?? "" };
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
    getOAuthConfig: () => resolveOAuthConfig({
      env: args.env ?? process.env,
      projectRoots: rootsFor(secretsDir),
    }),
    logger: args.logger,
  });
  sharedServices.set(secretsDir, service);
  return service;
}
