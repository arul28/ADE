import { resolveAcpExecutable } from "../ai/acpExecutables";

/**
 * ADE's pinned `devin` binary for relay calls, with this process's env. Null
 * when ADE has not downloaded Devin on this machine; a signed-out CLI still
 * resolves, and the relay's own error then says to run `devin auth login`.
 * A lookup only: it never starts a download.
 */
export async function resolveDevinCloudBinary(): Promise<{ path: string; env: NodeJS.ProcessEnv } | null> {
  const executable = resolveAcpExecutable("devin", { env: process.env });
  if (executable.source === "fallback-command") return null;
  return { path: executable.path, env: { ...process.env } };
}
