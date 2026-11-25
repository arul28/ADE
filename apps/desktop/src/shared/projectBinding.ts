import { basenameCrossPlatform } from "./pathDisplay";
import { remoteProjectBindingKey } from "./projectIdentity";
import type { OpenProjectBinding, RemoteOpenProjectBinding } from "./types/core";

/**
 * Project bindings read from outside: a window's state file, a renderer, or a
 * record that carried a chat's pin (a size change's, a server move's). Each
 * is rebuilt field by field. Main and ADE Web read them the same way.
 */

/** How a binding's icon is kept: as given when it is small enough, or none (`() => null`). */
export type BindingIconForPersistence = (value: string | null | undefined) => string | null;

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** A remote binding saved in this app's state, or null when it isn't one. */
export function parseSavedRemoteProjectBinding(
  value: unknown,
  iconForPersistence: BindingIconForPersistence,
): RemoteOpenProjectBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const targetId = readString(record, "targetId");
  const projectId = readString(record, "projectId");
  const rootPath = readString(record, "rootPath");
  const hostname = readString(record, "hostname");
  if (record.kind !== "remote" || !targetId || !projectId || !rootPath) {
    return null;
  }
  const gitOriginUrl = readString(record, "gitOriginUrl");
  return {
    kind: "remote",
    key: readString(record, "key") ?? remoteProjectBindingKey(targetId, projectId),
    targetId,
    runtimeName: readString(record, "runtimeName") ?? "Remote",
    transport: record.transport === "paired" ? "paired" : "ssh",
    ...(hostname ? { hostname } : {}),
    projectId,
    rootPath,
    displayName: readString(record, "displayName") ?? basenameCrossPlatform(rootPath),
    ...(gitOriginUrl ? { gitOriginUrl } : {}),
    // The cached project logo, so the tab shows it at once on a cold start,
    // before the remote reconnects and refreshes the icon.
    iconDataUrl: iconForPersistence(readString(record, "iconDataUrl")),
  };
}

/**
 * A binding that came from a renderer: a remote binding goes through the
 * saved-binding parser with its key recomputed, and a local one needs a
 * string root.
 */
export function sanitizeRendererProjectBinding(
  value: unknown,
  iconForPersistence: BindingIconForPersistence,
): OpenProjectBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "remote") {
    const remote = parseSavedRemoteProjectBinding(value, iconForPersistence);
    return remote ? { ...remote, key: remoteProjectBindingKey(remote.targetId, remote.projectId) } : null;
  }
  const rootPath = readString(record, "rootPath");
  if (record.kind !== "local" || !rootPath) return null;
  return {
    kind: "local",
    key: `local:${rootPath}`,
    rootPath,
    displayName: readString(record, "displayName") ?? basenameCrossPlatform(rootPath),
  };
}
