import path from "node:path";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { ProjectRegistry } from "../projects/projectRegistry";
import { resolveDeviceDisplayName } from "../sync/deviceRegistryService";
import {
  getSharedAccountAttestationConfig,
  getSharedAccountAuthService,
  resolveAccountOAuthConfig,
} from "../account/sharedAccountAuthService";
import { createRemoteMcpService, type RemoteMcpService } from "./remoteMcpService";

/**
 * The machine's one ADE MCP service. Machine-level like the relay
 * tunnel it rides on: every project scope and the projectless brain share it,
 * so its in-memory sign-ins and running-command count are one per machine.
 */

let shared: { home: string; service: RemoteMcpService } | null = null;

export function getSharedRemoteMcpService(logger?: Parameters<typeof createRemoteMcpService>[0]["logger"]): RemoteMcpService {
  const layout = resolveMachineAdeLayout();
  if (shared && shared.home === layout.adeDir) return shared.service;
  const registry = new ProjectRegistry(layout);
  const service = createRemoteMcpService({
    storePath: path.join(layout.secretsDir, "remote-mcp.json"),
    activityPath: path.join(layout.adeDir, "remote-mcp", "activity.jsonl"),
    machineName: () => resolveDeviceDisplayName(),
    listProjects: () => registry.list().map((record) => ({
      projectId: record.projectId,
      rootPath: record.rootPath,
      displayName: record.displayName,
      lastOpenedAt: record.lastOpenedAt,
    })),
    // The same account, Clerk client and attestation the relay's phone hellos
    // use: an app may connect only after its person signs in as this account.
    account: {
      signedIn: () => {
        const status = getSharedAccountAuthService({ secretsDir: layout.secretsDir }).getStatus();
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
    ...(logger ? { logger } : {}),
  });
  shared = { home: layout.adeDir, service };
  return service;
}
