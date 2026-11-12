import path from "node:path";
import { readAccountProjectState } from "../projects/accountProjectSync";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { ProjectRegistry } from "../projects/projectRegistry";
import { resolveDeviceDisplayName } from "../sync/deviceRegistryService";
import {
  getSharedAccountAttestationConfig,
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
  resolveAccountOAuthConfig,
} from "../account/sharedAccountAuthService";
import { AccountMachineDirectoryService } from "../account/accountMachineDirectoryService";
import { getMachineAccountStores } from "../account/machineAccountStores";
import { accountMachineDisplayName } from "../../../../desktop/src/shared/accountDirectory";
import { readChatLaunchDefaults } from "../../../../desktop/src/main/services/chat/chatLaunchDefaults";
import { createRemoteMcpService, type RemoteMcpService } from "./remoteMcpService";
import { remoteMcpAdeVersion } from "./remoteMcpAccount";
import { resolveModelSlug, type ModelProviderGroup } from "../../../../desktop/src/shared/modelRegistry";

/**
 * The machine's one ADE MCP service. Machine-level like the relay
 * tunnel it rides on: every project scope and the projectless brain share it,
 * so its in-memory sign-ins and running-command count are one per machine.
 *
 * It reads the account through the machine's shared account stores (one per
 * ADE home, the same instances a project runtime uses), so a projectless brain
 * serves ADE MCP too.
 */

type RemoteMcpLogger = NonNullable<Parameters<typeof createRemoteMcpService>[0]["logger"]>;

let shared: { home: string; service: RemoteMcpService } | null = null;
// Whoever reaches the service first may have no logger (`ade mcp` through
// `remoteMcp.call`); the brain's logger arrives with the relay tunnel. The
// service logs through this, so it uses the first real logger it is given.
let machineLogger: RemoteMcpLogger | null = null;
const forwardingLogger: RemoteMcpLogger = {
  info: (event, data) => machineLogger?.info?.(event, data),
  warn: (event, data) => machineLogger?.warn?.(event, data),
};
const storeLogger = {
  debug: () => {},
  info: (event: string, data?: Record<string, unknown>) => machineLogger?.info?.(event, data),
  warn: (event: string, data?: Record<string, unknown>) => machineLogger?.warn?.(event, data),
  error: (event: string, data?: Record<string, unknown>) => machineLogger?.warn?.(event, data),
};

export function getSharedRemoteMcpService(logger?: RemoteMcpLogger): RemoteMcpService {
  if (logger && !machineLogger) machineLogger = logger;
  const layout = resolveMachineAdeLayout();
  if (shared && shared.home === layout.adeDir) return shared.service;
  const registry = new ProjectRegistry(layout);
  const accountAuth = () => getSharedAccountAuthService({ secretsDir: layout.secretsDir });
  const { settings, vault } = getMachineAccountStores(storeLogger);
  const directory = new AccountMachineDirectoryService(accountAuth(), {
    appVersion: remoteMcpAdeVersion(),
    directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl({ secretsDir: layout.secretsDir }),
  });
  const service = createRemoteMcpService({
    legacyStorePath: path.join(layout.secretsDir, "remote-mcp.json"),
    activityPath: path.join(layout.adeDir, "remote-mcp", "activity.jsonl"),
    machineName: () => resolveDeviceDisplayName(),
    listProjects: () => registry.list().map((record) => ({
      projectId: record.projectId,
      rootPath: record.rootPath,
      displayName: record.displayName,
      lastOpenedAt: record.lastOpenedAt,
      accountProjectId: record.accountProjectId ?? null,
      gitOriginUrl: record.gitOriginUrl ?? null,
    })),
    // `project` may name an account project; it resolves against the list
    // this computer last read (merges followed, removals told).
    accountProjects: () => {
      const state = readAccountProjectState(layout.adeDir);
      return state.userId === null ? null : state.projects;
    },
    // chat_start opens on the model a new chat in ADE would.
    launchDefaults: () => {
      const defaults = readChatLaunchDefaults(layout.adeDir);
      if (!defaults?.provider || !defaults.modelId) return null;
      // A saved pick may predate full model names (`opus`); requests must
      // carry the full name, so the saved one is resolved here.
      // The saved provider is a provider group; an unknown one only skips the hint.
      const model = resolveModelSlug(defaults.modelId, defaults.provider as ModelProviderGroup) ?? defaults.modelId;
      return { provider: defaults.provider, model, reasoningEffort: defaults.reasoningEffort };
    },
    // The same account, Clerk client and attestation the relay's phone hellos
    // use: an app may connect only after its person signs in as this account.
    account: {
      signedIn: () => {
        const status = accountAuth().getStatus();
        const userId = status.signedIn ? status.userId?.trim() : "";
        return userId ? { userId, email: status.email, name: status.name } : null;
      },
      oauth: () => {
        const config = resolveAccountOAuthConfig({ env: process.env, projectRoots: [] });
        return config.issuer && config.clientId ? { issuer: config.issuer, clientId: config.clientId } : null;
      },
      attestation: () => {
        const config = getSharedAccountAttestationConfig({ secretsDir: layout.secretsDir });
        return config.issuer && config.jwksUrl && config.oauthClientId ? config : null;
      },
    },
    vault,
    settings,
    listAccountMachines: async () => {
      const listed = await directory.listMachines({ timeoutMs: 8_000 });
      if (listed.state !== "ok") return null;
      return listed.machines.map((machine) => ({
        machineKey: machine.machineKey,
        name: accountMachineDisplayName(machine),
        online: machine.online,
        lastSeenAt: machine.lastSeenAt,
      }));
    },
    logger: forwardingLogger,
  });
  // Another computer turning ADE MCP on or off, or leaving this one out,
  // arrives as a settings pull. Joins the runtime's sync when one runs; the
  // projectless brain gets its own. Held for the life of the process.
  settings.startPeriodicSync(undefined, () => service.refresh());
  shared = { home: layout.adeDir, service };
  return service;
}
