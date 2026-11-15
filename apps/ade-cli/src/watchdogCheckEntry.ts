/**
 * The `com.ade.watchdog` launch agent's entry: `runtime watchdog-check` without
 * the full CLI. launchd starts it every minute, and loading the whole CLI
 * bundle for it cost about 0.3 s of CPU and 235 MB per run on an idle Mac.
 * This file pulls in only the heartbeat check and launchd's kickstart.
 *
 * Same contract as the CLI command: it never opens the runtime socket (a
 * wedged brain is exactly when connecting hangs), it reads a file, and at most
 * it kills one pid and asks launchd to start its own job again.
 */
import { kickstartLaunchdServiceAfterExit } from "./serviceManager/installLaunchd";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import { runBrainWatchdogCheck } from "./services/runtime/brainWatchdogCheck";

async function main(): Promise<void> {
  const result = await runBrainWatchdogCheck({
    runtimeDir: resolveMachineAdeLayout().runtimeDir,
    restartService: process.platform === "darwin" ? kickstartLaunchdServiceAfterExit : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  // launchd keeps stderr in watchdog.err.log; the next run tries again.
  process.stderr.write(`ade watchdog-check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
