import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";
import type { RemoteRuntimeProjectRecord, RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import { bootstrapRemoteRuntime, ensureRemoteProject } from "./remoteBootstrap";
import type { RuntimeRpcClient } from "./runtimeRpcClient";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

type RemoteRuntimeE2eConfig = {
  host: string;
  user: string | null;
  port: number | null;
  keyPath: string | null;
  projectRoot: string;
  resourcesPath: string;
  appVersion: string;
  mutate: boolean;
  createPr: boolean;
  chatProvider: string;
  chatModel: string;
};

function readRemoteRuntimeE2eConfig(): RemoteRuntimeE2eConfig | null {
  const host = process.env.ADE_REMOTE_RUNTIME_E2E_HOST?.trim();
  const projectRoot = process.env.ADE_REMOTE_RUNTIME_E2E_PROJECT?.trim();
  if (!host || !projectRoot) return null;
  const portValue = Number.parseInt(process.env.ADE_REMOTE_RUNTIME_E2E_PORT ?? "", 10);
  return {
    host,
    user: process.env.ADE_REMOTE_RUNTIME_E2E_USER?.trim() || null,
    port: Number.isFinite(portValue) && portValue > 0 ? portValue : null,
    keyPath: process.env.ADE_REMOTE_RUNTIME_E2E_KEY?.trim() || null,
    projectRoot,
    resourcesPath: process.env.ADE_REMOTE_RUNTIME_E2E_RESOURCES?.trim() || process.resourcesPath || process.cwd(),
    appVersion: process.env.ADE_REMOTE_RUNTIME_E2E_APP_VERSION?.trim() || "0.0.0-e2e",
    mutate: process.env.ADE_REMOTE_RUNTIME_E2E_MUTATE === "1",
    createPr: process.env.ADE_REMOTE_RUNTIME_E2E_CREATE_PR === "1",
    chatProvider: process.env.ADE_REMOTE_RUNTIME_E2E_CHAT_PROVIDER?.trim() || "codex",
    chatModel: process.env.ADE_REMOTE_RUNTIME_E2E_CHAT_MODEL?.trim() || "gpt-5.4",
  };
}

const e2eConfig = readRemoteRuntimeE2eConfig();
const describeRemoteRuntimeE2e = e2eConfig ? describe : describe.skip;
const itMutatingRemoteRuntimeE2e = e2eConfig?.mutate ? it : it.skip;

type RemoteRuntimeE2eContext = {
  client: RuntimeRpcClient;
  project: RemoteRuntimeProjectRecord;
};

function targetForConfig(config: RemoteRuntimeE2eConfig): RemoteRuntimeTarget {
  return {
    id: "remote-runtime-e2e",
    name: "Remote runtime E2E",
    hostname: config.host,
    sshUser: config.user,
    port: config.port,
    sshKeyPath: config.keyPath,
    lastSeenArch: null,
    runtimeBinaryVersion: null,
    lastConnectedAt: null,
  };
}

async function withRemoteRuntimeE2e(
  config: RemoteRuntimeE2eConfig,
  run: (ctx: RemoteRuntimeE2eContext) => Promise<void>,
): Promise<void> {
  const target = targetForConfig(config);
  const registry = {
    update: (_id: string, patch: Partial<RemoteRuntimeTarget>) => ({ ...target, ...patch }),
  } as unknown as RemoteTargetRegistry;

  let client: RuntimeRpcClient | null = null;
  let ssh: Client | null = null;
  try {
    const connected = await bootstrapRemoteRuntime({
      target,
      registry,
      resourcesPath: config.resourcesPath,
      appVersion: config.appVersion,
    });
    client = connected.client;
    ssh = connected.ssh;

    expect(connected.result.projects).toEqual(expect.any(Array));
    const project = await ensureRemoteProject(client, config.projectRoot);
    expect(project.rootPath).toBe(config.projectRoot);
    await run({ client, project });
  } finally {
    client?.close();
    ssh?.end();
  }
}

async function runAdeAction(
  client: RuntimeRpcClient,
  projectId: string,
  domain: string,
  action: string,
  args?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const value = await client.call("ade/actions/call", {
    projectId,
    name: "run_ade_action",
    arguments: {
      domain,
      action,
      ...(args ? { args } : {}),
    },
  });
  expect(value).toMatchObject({ domain, action });
  return value as Record<string, unknown>;
}

describeRemoteRuntimeE2e("remote runtime SSH E2E", () => {
  it("connects over SSH, initializes stdio RPC, registers a project, and calls lane.list", async () => {
    const config = e2eConfig;
    expect(config).not.toBeNull();
    if (!config) return;

    await withRemoteRuntimeE2e(config, async ({ client, project }) => {
      const lanes = await runAdeAction(client, project.projectId, "lane", "list");
      expect(Array.isArray(lanes.result)).toBe(true);
    });
  }, 120_000);

  itMutatingRemoteRuntimeE2e("exercises remote lane, chat, git, and optional PR operations", async () => {
    const config = e2eConfig;
    expect(config).not.toBeNull();
    if (!config) return;

    const suffix = `${Date.now()}-${process.pid}`;
    await withRemoteRuntimeE2e(config, async ({ client, project }) => {
      const createdLane = await runAdeAction(client, project.projectId, "lane", "create", {
        name: `Remote runtime E2E ${suffix}`,
        branchName: `ade/remote-runtime-e2e-${suffix}`,
        description: "Created by ADE_REMOTE_RUNTIME_E2E_MUTATE acceptance coverage.",
      });
      const lane = createdLane.result as { id?: unknown; name?: unknown };
      expect(typeof lane.id).toBe("string");
      const laneId = lane.id as string;

      const chat = await runAdeAction(client, project.projectId, "chat", "createSession", {
        laneId,
        provider: config.chatProvider,
        model: config.chatModel,
        title: `Remote runtime E2E ${suffix}`,
        openInUi: false,
      });
      const chatSession = chat.result as { id?: unknown; laneId?: unknown };
      expect(typeof chatSession.id).toBe("string");
      expect(chatSession.laneId).toBe(laneId);

      const gitStatus = await runAdeAction(client, project.projectId, "git", "getSyncStatus", { laneId });
      expect(gitStatus.result).toEqual(expect.any(Object));

      if (config.createPr) {
        const pr = await runAdeAction(client, project.projectId, "pr", "createFromLane", {
          laneId,
          title: `Remote runtime E2E ${suffix}`,
          body: "Created by ADE_REMOTE_RUNTIME_E2E_CREATE_PR acceptance coverage.",
          draft: true,
        });
        expect(pr.result).toEqual(expect.objectContaining({ id: expect.any(String) }));
      }
    });
  }, 180_000);
});
