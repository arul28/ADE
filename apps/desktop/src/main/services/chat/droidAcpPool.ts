import type { ClientSideConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import type { AcpHostBridge, AcpHostTermState } from "./acpHostClient";
import { acquireAcpCliConnection, hasActiveAcpCliPoolEntry, releaseAcpCliConnection } from "./acpCliPool";

export type DroidAcpBridge = AcpHostBridge;

export type DroidAcpLaunchSettings = {
  /** Maps ADE unified permission / plan mode to Droid exec autonomy. */
  autonomy: "none" | "low" | "medium" | "high";
};

export type DroidTerminalWorkLogBinding = {
  itemId: string;
  turnId: string;
  command: string;
  cwd: string;
};

export type DroidAcpPooled = {
  connection: ClientSideConnection;
  bridge: DroidAcpBridge;
  terminals: Map<string, AcpHostTermState>;
  terminalWorkLogBindings: Map<string, DroidTerminalWorkLogBinding>;
  terminalOutputTimers: Map<string, ReturnType<typeof setTimeout>>;
  dispose: () => void;
};

const droidPools = new Map<string, { ref: number; pooled: DroidAcpPooled }>();

function internalPoolKey(poolKey: string): string {
  return `droid:${poolKey}`;
}

export async function acquireDroidAcpConnection(args: {
  poolKey: string;
  droidPath: string;
  workspacePath: string;
  modelId: string;
  launchSettings: DroidAcpLaunchSettings;
  appVersion: string;
}): Promise<DroidAcpPooled> {
  const spawnArgs = [
    "exec",
    "--output-format",
    "acp",
    "--cwd",
    args.workspacePath,
    "-m",
    args.modelId,
  ];
  if (args.launchSettings.autonomy !== "none") {
    spawnArgs.push("--auto", args.launchSettings.autonomy);
  }

  const acpOptions = {
    poolKey: internalPoolKey(args.poolKey),
    logPrefix: "[DroidAcpPool]",
    appVersion: args.appVersion,
    spawn: {
      command: args.droidPath,
      args: spawnArgs,
      cwd: args.workspacePath,
      env: { ...process.env } as NodeJS.ProcessEnv,
    },
    afterInitialize: async (_args: { connection: ClientSideConnection; initResult: InitializeResponse }) => {
      // Droid auth is typically via FACTORY_API_KEY or Factory CLI config — no ACP authenticate step today.
    },
  };

  const existing = droidPools.get(args.poolKey);
  if (existing) {
    const innerKey = internalPoolKey(args.poolKey);
    if (hasActiveAcpCliPoolEntry(innerKey)) {
      existing.ref += 1;
      return existing.pooled;
    }
    droidPools.delete(args.poolKey);
  }

  const base = await acquireAcpCliConnection(acpOptions);

  const terminalWorkLogBindings = new Map<string, DroidTerminalWorkLogBinding>();
  const terminalOutputTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const pooled: DroidAcpPooled = {
    connection: base.connection,
    bridge: base.bridge,
    terminals: base.terminals,
    terminalWorkLogBindings,
    terminalOutputTimers,
    dispose: base.dispose,
  };

  droidPools.set(args.poolKey, { ref: 1, pooled });
  return pooled;
}

export function releaseDroidAcpConnection(poolKey: string): void {
  const entry = droidPools.get(poolKey);
  if (!entry) return;
  entry.ref -= 1;
  releaseAcpCliConnection(internalPoolKey(poolKey));
  if (entry.ref <= 0) {
    droidPools.delete(poolKey);
  }
}
