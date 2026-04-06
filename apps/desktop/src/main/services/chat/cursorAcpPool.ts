import type { ClientSideConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import type { AcpHostBridge, AcpHostTermState } from "./acpHostClient";
import { acquireAcpCliConnection, hasActiveAcpCliPoolEntry, releaseAcpCliConnection } from "./acpCliPool";

export type CursorAcpBridge = AcpHostBridge;

export type CursorTerminalWorkLogBinding = {
  itemId: string;
  turnId: string;
  command: string;
  cwd: string;
};

export type CursorAcpPooled = {
  connection: ClientSideConnection;
  bridge: CursorAcpBridge;
  terminals: Map<string, AcpHostTermState>;
  /** Maps ACP terminal id → work chat command row identity for streaming output */
  terminalWorkLogBindings: Map<string, CursorTerminalWorkLogBinding>;
  terminalOutputTimers: Map<string, ReturnType<typeof setTimeout>>;
  dispose: () => void;
};

export type CursorAcpLaunchSettings = {
  mode: "plan" | "ask" | null;
  sandbox: "enabled" | "disabled";
  force: boolean;
  approveMcps: boolean;
};

const cursorPools = new Map<string, { ref: number; pooled: CursorAcpPooled }>();

function internalPoolKey(poolKey: string): string {
  return `cursor:${poolKey}`;
}

export async function acquireCursorAcpConnection(args: {
  poolKey: string;
  agentPath: string;
  workspacePath: string;
  modelSdkId: string;
  launchSettings: CursorAcpLaunchSettings;
  appVersion: string;
}): Promise<CursorAcpPooled> {
  const spawnArgs = [
    "acp",
    "--workspace",
    args.workspacePath,
    "--model",
    args.modelSdkId,
    "--sandbox",
    args.launchSettings.sandbox,
  ];
  if (args.launchSettings.mode) {
    spawnArgs.push("--mode", args.launchSettings.mode);
  }
  if (args.launchSettings.force) {
    spawnArgs.push("--force");
  }
  if (args.launchSettings.approveMcps) {
    spawnArgs.push("--approve-mcps");
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim();
  if (apiKey) {
    spawnArgs.push("--api-key", apiKey);
  }

  const acpOptions = {
    poolKey: internalPoolKey(args.poolKey),
    logPrefix: "[CursorAcpPool]",
    appVersion: args.appVersion,
    spawn: {
      command: args.agentPath,
      args: spawnArgs,
      cwd: args.workspacePath,
      env: { ...process.env } as NodeJS.ProcessEnv,
    },
    afterInitialize: async ({ connection, initResult }: { connection: ClientSideConnection; initResult: InitializeResponse }) => {
      const authMethods = initResult.authMethods ?? [];
      const needsCursorLogin = authMethods.some(
        (m: (typeof authMethods)[number]) => "id" in m && m.id === "cursor_login",
      );
      if (needsCursorLogin && !apiKey) {
        await connection.authenticate({ methodId: "cursor_login" }).catch(() => {
          // Interactive login may fail headless — user should run `agent login`
        });
      }
    },
  };

  const existing = cursorPools.get(args.poolKey);
  if (existing) {
    const innerKey = internalPoolKey(args.poolKey);
    if (hasActiveAcpCliPoolEntry(innerKey)) {
      existing.ref += 1;
      return existing.pooled;
    }
    cursorPools.delete(args.poolKey);
  }

  const base = await acquireAcpCliConnection(acpOptions);

  const terminalWorkLogBindings = new Map<string, CursorTerminalWorkLogBinding>();
  const terminalOutputTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const pooled: CursorAcpPooled = {
    connection: base.connection,
    bridge: base.bridge,
    terminals: base.terminals,
    terminalWorkLogBindings,
    terminalOutputTimers,
    dispose: base.dispose,
  };

  cursorPools.set(args.poolKey, { ref: 1, pooled });
  return pooled;
}

export function releaseCursorAcpConnection(poolKey: string): void {
  const entry = cursorPools.get(poolKey);
  if (!entry) return;
  entry.ref -= 1;
  releaseAcpCliConnection(internalPoolKey(poolKey));
  if (entry.ref <= 0) {
    cursorPools.delete(poolKey);
  }
}
