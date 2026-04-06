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

let cursorGenCounter = 0;
const cursorPools = new Map<string, { ref: number; generation: number; pooled: CursorAcpPooled }>();
const pendingCursorInit = new Map<string, Promise<CursorAcpPooled>>();

function internalPoolKey(poolKey: string): string {
  return `cursor:${poolKey}`;
}

function clearCursorTerminalTimers(pooled: CursorAcpPooled): void {
  for (const h of pooled.terminalOutputTimers.values()) {
    clearTimeout(h);
  }
  pooled.terminalOutputTimers.clear();
}

export async function acquireCursorAcpConnection(args: {
  poolKey: string;
  agentPath: string;
  workspacePath: string;
  modelSdkId: string;
  launchSettings: CursorAcpLaunchSettings;
  appVersion: string;
}): Promise<{ pooled: CursorAcpPooled; generation: number }> {
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

  const innerKey = internalPoolKey(args.poolKey);
  const staleOuter = cursorPools.get(args.poolKey);
  if (staleOuter && !hasActiveAcpCliPoolEntry(innerKey)) {
    cursorPools.delete(args.poolKey);
  }

  const existing = cursorPools.get(args.poolKey);
  if (existing && hasActiveAcpCliPoolEntry(innerKey)) {
    await acquireAcpCliConnection(acpOptions);
    existing.ref += 1;
    return { pooled: existing.pooled, generation: existing.generation };
  }

  // Existing entry is stale — clean it up before creating a new one
  if (existing) {
    cursorPools.delete(args.poolKey);
  }

  let initOwner = false;
  let init = pendingCursorInit.get(args.poolKey);
  if (!init) {
    initOwner = true;
    init = (async () => {
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

      const generation = ++cursorGenCounter;
      cursorPools.set(args.poolKey, { ref: 1, generation, pooled });
      return pooled;
    })().finally(() => {
      pendingCursorInit.delete(args.poolKey);
    });
    pendingCursorInit.set(args.poolKey, init);
  }

  const pooled = await init;
  if (!initOwner) {
    await acquireAcpCliConnection(acpOptions);
    const entry = cursorPools.get(args.poolKey);
    if (entry) entry.ref += 1;
  }
  const entry = cursorPools.get(args.poolKey);
  return { pooled, generation: entry?.generation ?? 0 };
}

export function releaseCursorAcpConnection(poolKey: string, generation?: number): void {
  const entry = cursorPools.get(poolKey);
  if (!entry) return;
  if (generation !== undefined && entry.generation !== generation) return;
  entry.ref -= 1;
  if (entry.ref < 0) entry.ref = 0;
  releaseAcpCliConnection(internalPoolKey(poolKey));
  if (entry.ref <= 0) {
    clearCursorTerminalTimers(entry.pooled);
    cursorPools.delete(poolKey);
  }
}
