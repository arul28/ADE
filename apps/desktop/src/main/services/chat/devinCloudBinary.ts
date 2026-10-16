import { resolveAcpExecutable } from "../ai/acpExecutables";
import { detectCliAuthStatuses } from "../ai/authDetector";

/**
 * The `devin` binary for relay calls, with this process's env. Null when the
 * CLI is not installed; a signed-out CLI still resolves, and the relay's own
 * error then says to run `devin auth login`.
 */
export async function resolveDevinCloudBinary(): Promise<{ path: string; env: NodeJS.ProcessEnv } | null> {
  const statuses = await detectCliAuthStatuses({ skipAuthProbe: true }).catch(() => []);
  const cli = statuses.find((entry) => entry.cli === "devin") ?? null;
  if (cli && !cli.installed) return null;
  const executable = resolveAcpExecutable("devin", {
    env: process.env,
    ...(cli?.path ? { auth: [{ type: "cli-subscription", cli: "devin", path: cli.path, authenticated: cli.authenticated, verified: cli.verified }] } : {}),
  });
  return { path: executable.path, env: { ...process.env } };
}
