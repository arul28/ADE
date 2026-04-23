import { createHash } from "node:crypto";
import path from "node:path";

export function isAdeMcpNamedPipePath(socketPath: string): boolean {
  const p = socketPath.trim();
  if (!p) return false;
  const lower = p.toLowerCase();
  return lower.startsWith("\\\\.\\pipe\\") || lower.startsWith("//./pipe/");
}

export function resolveAdeMcpIpcPath(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  if (process.platform === "win32") {
    const id = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\ade-${id}`;
  }
  return path.join(root, ".ade", "ade.sock");
}
