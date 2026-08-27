import type { OpenProjectBinding } from "./types/core";

type VscodeFamilyRemoteOpen = {
  kind: "vscode-ssh";
  osScheme: "vscode" | "vscode-insiders" | "vscodium";
};

type ZedRemoteOpen = {
  kind: "zed-ssh";
};

type EditorTargetDefinition = {
  id: string;
  label: string;
  command: string;
  macAppName: string;
  supportsRemote: boolean;
  remoteOpen?: VscodeFamilyRemoteOpen | ZedRemoteOpen;
};

/** Editors that ADE can discover and open with a workspace path. */
export const EDITOR_TARGETS = [
  { id: "vscode", label: "Visual Studio Code", command: "code", macAppName: "Visual Studio Code", supportsRemote: true, remoteOpen: { kind: "vscode-ssh", osScheme: "vscode" } },
  { id: "vscode-insiders", label: "Visual Studio Code Insiders", command: "code-insiders", macAppName: "Visual Studio Code - Insiders", supportsRemote: true, remoteOpen: { kind: "vscode-ssh", osScheme: "vscode-insiders" } },
  { id: "vscodium", label: "VSCodium", command: "codium", macAppName: "VSCodium", supportsRemote: true, remoteOpen: { kind: "vscode-ssh", osScheme: "vscodium" } },
  { id: "cursor", label: "Cursor", command: "cursor", macAppName: "Cursor", supportsRemote: false },
  { id: "zed", label: "Zed", command: "zed", macAppName: "Zed", supportsRemote: true, remoteOpen: { kind: "zed-ssh" } },
  { id: "zeditor", label: "Zed Editor", command: "zeditor", macAppName: "Zed", supportsRemote: true, remoteOpen: { kind: "zed-ssh" } },
  { id: "windsurf", label: "Windsurf", command: "windsurf", macAppName: "Windsurf", supportsRemote: false },
  { id: "trae", label: "Trae", command: "trae", macAppName: "Trae", supportsRemote: false },
  { id: "kiro", label: "Kiro", command: "kiro", macAppName: "Kiro", supportsRemote: false },
  { id: "antigravity", label: "Antigravity", command: "antigravity", macAppName: "Antigravity", supportsRemote: false },
  { id: "sublime-text", label: "Sublime Text", command: "subl", macAppName: "Sublime Text", supportsRemote: false },
  { id: "fleet", label: "JetBrains Fleet", command: "fleet", macAppName: "Fleet", supportsRemote: false },
  { id: "intellij-idea", label: "IntelliJ IDEA", command: "idea", macAppName: "IntelliJ IDEA", supportsRemote: false },
  { id: "webstorm", label: "WebStorm", command: "webstorm", macAppName: "WebStorm", supportsRemote: false },
  { id: "android-studio", label: "Android Studio", command: "studio", macAppName: "Android Studio", supportsRemote: false },
  { id: "xcode", label: "Xcode", command: "xed", macAppName: "Xcode", supportsRemote: false },
] as const satisfies readonly EditorTargetDefinition[];

export type EditorTarget = (typeof EDITOR_TARGETS)[number]["id"];
export type OpenPathTarget = "default" | "finder" | EditorTarget;

export type OpenPathInEditorRemote = {
  hostname: string;
  transport?: "ssh" | "paired";
};

export function editorTargetDefinition(target: EditorTarget) {
  return EDITOR_TARGETS.find((entry) => entry.id === target) ?? null;
}

export function isRemoteEditorOpenRequest(
  remote: { hostname?: string; transport?: "ssh" | "paired" } | null | undefined,
): remote is { hostname: string; transport?: "ssh" | "paired" } {
  return Boolean(remote?.hostname?.trim()) && remote?.transport !== "paired";
}

export function canOfferOpenIn(args: {
  worktreePath?: string | null;
  binding?: OpenProjectBinding | null;
}): args is { worktreePath: string; binding?: OpenProjectBinding | null } {
  const worktreePath = args.worktreePath?.trim() ?? "";
  if (!worktreePath) return false;
  if (args.binding?.kind !== "remote") return true;
  return isRemoteEditorOpenRequest(args.binding);
}

export type OpenInTarget = {
  rootPath: string;
  remote?: OpenPathInEditorRemote;
};

function openInRemoteFromBinding(
  binding?: OpenProjectBinding | null,
): OpenPathInEditorRemote | undefined {
  if (binding?.kind !== "remote" || !isRemoteEditorOpenRequest(binding)) return undefined;
  return {
    hostname: binding.hostname.trim(),
    ...(binding.transport ? { transport: binding.transport } : {}),
  };
}

export function resolveOpenInTarget(args: {
  worktreePath?: string | null;
  binding?: OpenProjectBinding | null;
}): OpenInTarget | null {
  if (!canOfferOpenIn(args)) return null;
  const remote = openInRemoteFromBinding(args.binding);
  return remote
    ? { rootPath: args.worktreePath, remote }
    : { rootPath: args.worktreePath };
}

function encodeRemoteHost(hostname: string): string {
  return encodeURIComponent(hostname)
    .replace(/%40/gi, "@")
    .replace(/%3A/gi, ":");
}

export function encodeRemoteEditorPath(rootPath: string): string {
  let normalized = rootPath.trim().replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = `/${normalized}`;
  } else if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  return normalized.split("/").map((segment, index) => {
    if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
    return encodeURIComponent(segment);
  }).join("/");
}

export function buildRemoteEditorUrl(
  target: EditorTarget,
  hostname: string,
  rootPath: string,
): string | null {
  const definition = editorTargetDefinition(target);
  if (!definition?.supportsRemote || !definition.remoteOpen) return null;
  const host = encodeRemoteHost(hostname.trim());
  if (!host) return null;
  const path = encodeRemoteEditorPath(rootPath);
  if (definition.remoteOpen.kind === "zed-ssh") {
    return `zed://ssh/${host}${path}`;
  }
  return `${definition.remoteOpen.osScheme}://vscode-remote/ssh-remote+${host}${path}`;
}
