import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dialog } from "electron";
import type { BrowserWindow, Session, WebContents } from "electron";
import type { BuiltInBrowserPermissionDecision } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";

const PERMISSION_STORE_VERSION = 1;
const MAX_PERMISSION_DECISIONS = 500;

const GOOGLE_AUTH_PERMISSION_ALLOWLIST = new Set([
  "storage-access",
  "top-level-storage-access",
]);

const PROMPTABLE_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "geolocation",
  "idle-detection",
  "keyboardLock",
  "media",
  "mediaKeySystem",
  "midi",
  "midiSysex",
  "notifications",
  "openExternal",
  "pointerLock",
  "speaker-selection",
  "storage-access",
  "top-level-storage-access",
  "window-management",
]);

type PermissionStoreFile = {
  version: typeof PERMISSION_STORE_VERSION;
  decisions: BuiltInBrowserPermissionDecision[];
};

type PermissionPromptResult = {
  granted: boolean;
  remember: boolean;
};

type SessionPermissionDecision = Omit<BuiltInBrowserPermissionDecision, "updatedAt">;

export function createBuiltInBrowserPermissionController(args: {
  filePath: string | null;
  isManagedWebContents: (webContents: WebContents | null) => boolean;
  resolveParentWindow: () => BrowserWindow | null;
  getLogger?: () => Logger | null;
  prompt?: (input: {
    parent: BrowserWindow | null;
    permission: string;
    origin: string;
    embeddingOrigin: string | null;
  }) => Promise<PermissionPromptResult>;
}) {
  const decisions = new Map<string, BuiltInBrowserPermissionDecision>(
    (args.filePath ? loadPermissionDecisions(args.filePath) : []).map((decision) => [permissionDecisionKey(decision), decision]),
  );
  const sessionDecisions = new Map<string, SessionPermissionDecision>();
  const configuredSessions = new WeakSet<Session>();
  const pendingPrompts = new Map<string, Promise<boolean>>();
  let writeChain = Promise.resolve();

  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  const persist = async (): Promise<void> => {
    if (!args.filePath) return;
    const state: PermissionStoreFile = {
      version: PERMISSION_STORE_VERSION,
      decisions: [...decisions.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_PERMISSION_DECISIONS),
    };
    writeChain = writeChain.then(
      () => writeJsonAtomically(args.filePath!, state),
      () => writeJsonAtomically(args.filePath!, state),
    );
    await writeChain;
  };

  const requestPermission = async (
    webContents: WebContents,
    permission: string,
    details: unknown,
  ): Promise<boolean> => {
    const request = permissionRequest(permission, webContents, details);
    if (!request || !args.isManagedWebContents(webContents)) return false;
    if (shouldAllowGoogleAuthPermissionRequest(permission, details)) return true;
    if (!PROMPTABLE_PERMISSIONS.has(permission)) return false;

    const key = permissionDecisionKey(request);
    const sessionDecision = sessionDecisions.get(key);
    if (sessionDecision) return sessionDecision.decision === "allow";
    const stored = decisions.get(key);
    if (stored) return stored.decision === "allow";

    const existingPrompt = pendingPrompts.get(key);
    if (existingPrompt) return existingPrompt;
    const prompt = (async () => {
      const result = await (args.prompt ?? showPermissionPrompt)({
        parent: args.resolveParentWindow(),
        permission: request.permission,
        origin: request.origin,
        embeddingOrigin: request.embeddingOrigin,
      });
      if (result.remember) {
        sessionDecisions.delete(key);
        decisions.set(key, {
          ...request,
          decision: result.granted ? "allow" : "block",
          updatedAt: new Date().toISOString(),
        });
        trimPermissionDecisions(decisions);
        try {
          await persist();
        } catch (error) {
          logger()?.warn("built_in_browser.permission_persist_failed", {
            permission: request.permission,
            origin: request.origin,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        sessionDecisions.set(key, {
          ...request,
          decision: result.granted ? "allow" : "block",
        });
      }
      logger()?.info("built_in_browser.permission_decided", {
        permission: request.permission,
        origin: request.origin,
        embeddingOrigin: request.embeddingOrigin,
        decision: result.granted ? "allow" : "block",
        remembered: result.remember,
      });
      return result.granted;
    })().finally(() => {
      pendingPrompts.delete(key);
    });
    pendingPrompts.set(key, prompt);
    return prompt;
  };

  return {
    configureSession(browserSession: Session): void {
      if (configuredSessions.has(browserSession)) return;
      configuredSessions.add(browserSession);
      browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        if (!args.isManagedWebContents(webContents)) return false;
        if (shouldAllowGoogleAuthPermissionCheck(permission, requestingOrigin, details)) return true;
        const request = permissionCheck(permission, webContents, requestingOrigin, details);
        if (!request) return false;
        const key = permissionDecisionKey(request);
        const sessionDecision = sessionDecisions.get(key);
        const stored = decisions.get(key);
        const allowed = sessionDecision?.decision === "allow" || stored?.decision === "allow";
        logger()?.debug(allowed ? "built_in_browser.permission_check_allowed" : "built_in_browser.permission_check_denied", {
          permission: request.permission,
          origin: request.origin,
          embeddingOrigin: request.embeddingOrigin,
          source: sessionDecision ? "session" : stored ? "persisted" : "default",
        });
        return allowed;
      });
      browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        void requestPermission(webContents, permission, details).then(callback, (error) => {
          logger()?.warn("built_in_browser.permission_request_failed", {
            permission,
            error: error instanceof Error ? error.message : String(error),
          });
          callback(false);
        });
      });
    },
    list(): BuiltInBrowserPermissionDecision[] {
      return [...decisions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async clear(input: { origin?: string | null; permission?: string | null } = {}): Promise<number> {
      const rawOrigin = normalizedString(input.origin);
      const origin = normalizedOrigin(input.origin);
      if (rawOrigin && !origin) throw new Error(`Invalid permission origin: ${rawOrigin}`);
      const permission = normalizedString(input.permission);
      const removedKeys = new Set<string>();
      let persistedRemoved = false;
      for (const [key, decision] of decisions) {
        if (origin && decision.origin !== origin) continue;
        if (permission && decision.permission !== permission) continue;
        decisions.delete(key);
        removedKeys.add(key);
        persistedRemoved = true;
      }
      for (const [key, decision] of sessionDecisions) {
        if (origin && decision.origin !== origin) continue;
        if (permission && decision.permission !== permission) continue;
        sessionDecisions.delete(key);
        removedKeys.add(key);
      }
      if (persistedRemoved) await persist();
      return removedKeys.size;
    },
    count(): number {
      return decisions.size;
    },
    async flush(): Promise<void> {
      await writeChain;
    },
  };
}

export function shouldAllowGoogleAuthPermissionCheck(
  permission: string,
  requestingOrigin: string,
  details: Electron.PermissionCheckHandlerHandlerDetails,
): boolean {
  if (!GOOGLE_AUTH_PERMISSION_ALLOWLIST.has(permission)) return false;
  return (
    isGoogleAccountsSurface(requestingOrigin)
    || isGoogleAccountsSurface(details.requestingUrl)
    || isGoogleAccountsSurface(details.embeddingOrigin)
    || isGoogleAccountsSurface(details.securityOrigin)
  );
}

export function shouldAllowGoogleAuthPermissionRequest(permission: string, details: unknown): boolean {
  if (!GOOGLE_AUTH_PERMISSION_ALLOWLIST.has(permission)) return false;
  if (!isRecord(details)) return false;
  return (
    isGoogleAccountsSurface(details.requestingUrl)
    || isGoogleAccountsSurface(details.requestingOrigin)
    || isGoogleAccountsSurface(details.securityOrigin)
  );
}

function permissionCheck(
  permission: string,
  webContents: WebContents | null,
  requestingOrigin: string,
  details: Electron.PermissionCheckHandlerHandlerDetails,
): Omit<BuiltInBrowserPermissionDecision, "decision" | "updatedAt"> | null {
  const origin = normalizedOrigin(requestingOrigin)
    ?? normalizedOrigin(details.securityOrigin)
    ?? normalizedOrigin(details.requestingUrl)
    ?? normalizedOrigin(webContents?.getURL());
  if (!origin || !isSecureBrowserOrigin(origin)) return null;
  return {
    permission: scopedPermission(permission, details.mediaType ? [details.mediaType] : []),
    origin,
    embeddingOrigin: normalizedEmbeddingOrigin(origin, details.embeddingOrigin, webContents?.getURL()),
  };
}

function permissionRequest(
  permission: string,
  webContents: WebContents,
  details: unknown,
): Omit<BuiltInBrowserPermissionDecision, "decision" | "updatedAt"> | null {
  if (!isRecord(details)) return null;
  const origin = normalizedOrigin(details.securityOrigin)
    ?? normalizedOrigin(details.requestingOrigin)
    ?? normalizedOrigin(details.requestingUrl)
    ?? normalizedOrigin(webContents.getURL());
  if (!origin || !isSecureBrowserOrigin(origin)) return null;
  const mediaTypes = Array.isArray(details.mediaTypes)
    ? details.mediaTypes.filter((value): value is string => typeof value === "string")
    : [];
  return {
    permission: scopedPermission(permission, mediaTypes),
    origin,
    embeddingOrigin: normalizedEmbeddingOrigin(origin, null, webContents.getURL()),
  };
}

function scopedPermission(permission: string, mediaTypes: string[]): string {
  if (permission !== "media") return permission;
  const types = [...new Set(mediaTypes.filter((value) => value === "audio" || value === "video"))].sort();
  return types.length ? `media:${types.join("+")}` : "media";
}

function permissionDecisionKey(
  decision: Pick<BuiltInBrowserPermissionDecision, "permission" | "origin" | "embeddingOrigin">,
): string {
  return JSON.stringify([decision.permission, decision.origin, decision.embeddingOrigin]);
}

function trimPermissionDecisions(decisions: Map<string, BuiltInBrowserPermissionDecision>): void {
  if (decisions.size <= MAX_PERMISSION_DECISIONS) return;
  const keep = new Set([...decisions.entries()]
    .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
    .slice(0, MAX_PERMISSION_DECISIONS)
    .map(([key]) => key));
  for (const key of decisions.keys()) {
    if (!keep.has(key)) decisions.delete(key);
  }
}

function normalizedEmbeddingOrigin(
  requestingOrigin: string,
  explicitEmbeddingOrigin: unknown,
  topLevelUrl: unknown,
): string | null {
  const explicit = normalizedOrigin(explicitEmbeddingOrigin);
  if (explicit && explicit !== requestingOrigin) return explicit;
  const topLevel = normalizedOrigin(topLevelUrl);
  return topLevel && topLevel !== requestingOrigin ? topLevel : null;
}

function normalizedOrigin(value: unknown): string | null {
  const text = normalizedString(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

function isSecureBrowserOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

function loadPermissionDecisions(filePath: string): BuiltInBrowserPermissionDecision[] {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== PERMISSION_STORE_VERSION || !Array.isArray(parsed.decisions)) return [];
    return parsed.decisions
      .map(normalizeStoredDecision)
      .filter((decision): decision is BuiltInBrowserPermissionDecision => Boolean(decision))
      .slice(0, MAX_PERMISSION_DECISIONS);
  } catch {
    return [];
  }
}

function normalizeStoredDecision(value: unknown): BuiltInBrowserPermissionDecision | null {
  if (!isRecord(value)) return null;
  const permission = normalizedString(value.permission);
  const origin = normalizedOrigin(value.origin);
  const embeddingOrigin = value.embeddingOrigin == null ? null : normalizedOrigin(value.embeddingOrigin);
  const decision = value.decision === "allow" || value.decision === "block" ? value.decision : null;
  const updatedAt = normalizedString(value.updatedAt);
  if (!permission || !origin || !decision || !updatedAt || !isSecureBrowserOrigin(origin)) return null;
  return { permission, origin, embeddingOrigin, decision, updatedAt };
}

async function showPermissionPrompt(input: {
  parent: BrowserWindow | null;
  permission: string;
  origin: string;
  embeddingOrigin: string | null;
}): Promise<PermissionPromptResult> {
  const options = {
    type: "question" as const,
    buttons: ["Allow", "Block"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    checkboxLabel: "Remember this decision for this site",
    checkboxChecked: true,
    message: `${input.origin} wants permission to ${permissionDescription(input.permission)}.`,
    detail: input.embeddingOrigin
      ? `This request is embedded in ${input.embeddingOrigin}. Only allow it if you trust both sites.`
      : "Only allow this if you trust the site.",
  };
  const result = input.parent
    ? await dialog.showMessageBox(input.parent, options)
    : await dialog.showMessageBox(options);
  return { granted: result.response === 0, remember: result.checkboxChecked === true };
}

function permissionDescription(permission: string): string {
  if (permission.startsWith("media:")) return `use your ${permission.slice("media:".length).replace("+", " and ")}`;
  const descriptions: Record<string, string> = {
    "clipboard-read": "read the clipboard",
    "clipboard-sanitized-write": "write to the clipboard",
    fullscreen: "enter full screen",
    geolocation: "access your location",
    "idle-detection": "detect when you are idle",
    keyboardLock: "capture system keyboard shortcuts",
    media: "use the camera or microphone",
    mediaKeySystem: "use protected media playback",
    midi: "access MIDI devices",
    midiSysex: "access MIDI devices with system-exclusive messages",
    notifications: "show notifications",
    openExternal: "open another application",
    pointerLock: "capture the pointer",
    "speaker-selection": "choose an audio output device",
    "storage-access": "use cross-site cookies and storage",
    "top-level-storage-access": "use top-level cross-site cookies and storage",
    "window-management": "inspect and manage connected displays",
  };
  return descriptions[permission] ?? `use ${permission}`;
}

function isGoogleAccountsSurface(value: unknown): boolean {
  const text = normalizedString(value);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && (
      parsed.hostname === "accounts.google.com"
      || parsed.hostname.endsWith(".accounts.google.com")
    );
  } catch {
    return false;
  }
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}
