import {
  DEFAULT_AUTO_UPDATE_PREFERENCES,
  type AppInfo,
  type AppResourceUsageSnapshot,
  type AppWelcomeVideoState,
  type AutoUpdatePreferences,
  type ProjectInfo,
  type UpdateInstallImpact,
} from "../../../shared/types";
import type { AdapterInfra, AdeNamespace } from "./types";
import { requestDataUrl } from "./infra/fileBlob";

const WELCOME_VIDEO_ID = "ade-welcome";
const WELCOME_VIDEO_VERSION = 1;

export function createAppNamespace(infra: AdapterInfra): AdeNamespace<"app"> {
  const { client, commands, events, localState, state } = infra;

  const app: Record<string, unknown> = {
    async ping() {
      return "pong";
    },
    async getInfo(): Promise<AppInfo> {
      return {
        appVersion: "web",
        // The hosted web client is not a packaged channel build; the channel
        // badge and early-build notice belong to the desktop app.
        packageChannel: "stable",
        isPackaged: false,
        // No `automations.*` action is registered host-side, so the builder's
        // saves would resolve against a missing descriptor and vanish. Reporting
        // the feature as off gives anyone who reaches /automations by URL or
        // palette the coming-soon screen instead of a rule editor that lies.
        automationsEnabled: false,
        platform: browserPlatform(),
        arch: "web",
        versions: {
          electron: "web",
          chrome: userAgent(),
          node: "web",
          v8: "web",
        },
        env: {},
        localRuntime: {
          connectionState: client.getStatus().state === "connected" ? "connected" : "idle",
          pid: null,
          syncPort: null,
          publishHealth: null,
          lastWedge: null,
          runtimeMode: "primary",
          versionSkew: {
            state: "none",
            appVersion: "web",
            runtimeVersion: null,
            message: null,
            updatedAt: new Date(0).toISOString(),
          },
          serviceInstall: {
            state: "installed",
            attempted: true,
            path: null,
            message: null,
            exitCode: null,
            updatedAt: null,
          },
          serviceHealth: {
            state: client.getStatus().state === "connected" ? "running" : "unknown",
            installed: true,
            running: client.getStatus().state === "connected",
            path: null,
            message: client.getStatus().error,
            checkedAt: client.getStatus().lastSeenAt,
          },
        },
      };
    },
    async getWindowSession() {
      return {
        windowId: null,
        project: state.getProject(),
        binding: null,
        openProjectTabs: state.getOpenProjectTabs(),
      };
    },
    async getProject(): Promise<ProjectInfo | null> {
      return state.getProject();
    },
    async getResourceUsage(): Promise<AppResourceUsageSnapshot> {
      const memory = browserMemoryMB();
      return {
        sampledAt: new Date().toISOString(),
        processCount: 1,
        cpuPercent: null,
        mainCpuPercent: null,
        rendererCpuPercent: null,
        memoryMB: memory,
        mainMemoryMB: null,
        rendererMemoryMB: memory,
        freeMemoryMB: null,
        totalMemoryMB: null,
        activePtyCount: 0,
        ptyProcessCount: 0,
        ptyCpuPercent: null,
        ptyMemoryMB: null,
      };
    },
    async setWindowProjectTabs(rootPaths: string[]) {
      const openProjectTabs = rootPaths
        .map((rootPath) => {
          if (state.getProject()?.rootPath === rootPath) return state.getProject();
          const catalogProject = state.getCatalogProjects().find((entry) => entry.rootPath === rootPath);
          return catalogProject
            ? {
                rootPath: catalogProject.rootPath,
                displayName: catalogProject.displayName,
                baseRef: catalogProject.defaultBaseRef,
              }
            : null;
        })
        .filter(Boolean) as ProjectInfo[];
      localState.set("openProjectTabs", openProjectTabs);
      return { openProjectTabs };
    },
    async newWindow() {
      if (typeof window !== "undefined") window.open(window.location.href, "_blank", "noopener,noreferrer");
      return { windowId: null, project: state.getProject() };
    },
    async openProjectInNewWindow(rootPath: string) {
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.set("projectRoot", rootPath);
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      }
      return { windowId: null };
    },
    async closeWindow() {
      if (typeof window !== "undefined") window.close();
      return { closed: false };
    },
    async openExternal(url: string) {
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
    },
    async revealPath() {
      return undefined;
    },
    async openPath() {
      return undefined;
    },
    async openPathInEditor() {
      return undefined;
    },
    async writeClipboardText(text: string) {
      await safeClipboardWrite(text);
    },
    async readClipboardText() {
      return await safeClipboardRead();
    },
    // `data` is bare base64 on desktop (the IPC handler does
    // Buffer.from(data, "base64")), and callers rely on that: AgentChatComposer
    // both forwards it to saveTempAttachment and builds `data:<mime>;base64,`
    // previews from it. Returning a data URL here corrupted both.
    async readClipboardImage() {
      const image = await readClipboardImage();
      return image ? { data: image.base64, filename: image.filename, mimeType: image.mimeType } : null;
    },
    async saveClipboardImageAttachment(args: Record<string, unknown> = {}) {
      const image = await readClipboardImage();
      if (!image) return null;
      // Send the data URL under its own key: that host branch reads the mime
      // from the URL itself. Under `data` it would be decoded as raw base64 and
      // rejected as invalid.
      return await commands.call("chat.saveTempAttachment", { ...args, dataUrl: image.dataUrl, filename: image.filename }, {
        fallback: { path: "", mimeType: image.mimeType, previewDataUrl: image.dataUrl },
        idempotent: false,
      });
    },
    async getImageDataUrl(args: string | { path?: string; artifactPath?: string }) {
      const path = typeof args === "string" ? args : args.path ?? args.artifactPath ?? "";
      if (!path) return { dataUrl: "" };
      return { dataUrl: (await requestDataUrl(client, state, "readArtifact", { path }).catch(() => null)) ?? "" };
    },
    async logDebugEvent(name: string) {
      console.debug("[ade-web]", name);
    },
    async getWelcomeVideoState(): Promise<AppWelcomeVideoState> {
      return localState.get<AppWelcomeVideoState>("welcomeVideo", {
        videoId: WELCOME_VIDEO_ID,
        version: WELCOME_VIDEO_VERSION,
        completedAt: null,
        dismissedAt: null,
      });
    },
    async markWelcomeVideoSeen(reason: "completed" | "dismissed" = "completed") {
      const now = new Date().toISOString();
      const next = {
        videoId: WELCOME_VIDEO_ID,
        version: WELCOME_VIDEO_VERSION,
        completedAt: reason === "completed" ? now : null,
        dismissedAt: reason === "dismissed" ? now : null,
      };
      localState.set<AppWelcomeVideoState>("welcomeVideo", next);
      return next;
    },
    async getLaunchGateState() {
      return { resolved: true };
    },
    async resolveLaunchGate() {
      return { resolved: true as const };
    },
    onProjectChanged(listener: (project: ProjectInfo | null) => void) {
      return events.on("projectChanged", listener);
    },
    onProjectBindingChanged(listener: (binding: unknown) => void) {
      return events.on("projectBindingChanged", listener as never);
    },
    onNavigate(listener: (request: unknown) => void) {
      return events.on("navigate", listener as never);
    },
  };
  return app as AdeNamespace<"app">;
}

export const webUpdateMethods = {
  async updateGetState() {
    return {
      status: "idle",
      currentVersion: "",
      latestKnownVersion: null,
      version: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      releaseNotesUrl: null,
      error: null,
      errorDetails: null,
      recentlyInstalled: null,
      parked: null,
      lastInstallFailed: null,
      autoApplyPending: null,
      autoApplySuppressedUntil: null,
    };
  },
  async updateCheckNow() {
    return {
      status: "idle",
      currentVersion: "",
      latestKnownVersion: null,
      version: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      releaseNotesUrl: null,
      error: null,
      errorDetails: null,
      recentlyInstalled: null,
      parked: null,
      lastInstallFailed: null,
      autoApplyPending: null,
      autoApplySuppressedUntil: null,
    };
  },
  async updateGetPreferences() {
    return { ...DEFAULT_AUTO_UPDATE_PREFERENCES };
  },
  async updateSetPreferences(preferences: AutoUpdatePreferences) {
    return preferences;
  },
  async updateGetInstallImpact(): Promise<UpdateInstallImpact> {
    return { connectedPhones: [] };
  },
  async updateQuitAndInstall() {
    return false;
  },
  async updateCancelAutoApply() {
    return false;
  },
};

function browserPlatform(): NodeJS.Platform {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "darwin";
  if (platform.includes("win")) return "win32";
  if (platform.includes("linux")) return "linux";
  return "browser" as NodeJS.Platform;
}

function userAgent(): string {
  return typeof navigator === "undefined" ? "web" : navigator.userAgent;
}

function browserMemoryMB(): number | null {
  const performanceWithMemory = typeof performance === "undefined" ? null : (performance as Performance & { memory?: { usedJSHeapSize?: number } });
  const bytes = performanceWithMemory?.memory?.usedJSHeapSize;
  return typeof bytes === "number" ? Math.round((bytes / 1024 / 1024) * 10) / 10 : null;
}

async function safeClipboardWrite(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // Clipboard permissions vary by browser and context.
  }
}

async function safeClipboardRead(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

// Attachment sinks resolve the stored file's type from the filename extension
// when no mime is supplied, then reject the payload if the sniffed bytes
// disagree — so a webp on the clipboard must not be announced as .png.
const CLIPBOARD_IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/svg+xml": ".svg",
};

async function readClipboardImage(): Promise<{
  base64: string;
  dataUrl: string;
  filename: string;
  mimeType: string;
} | null> {
  const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
  const read = (clipboard as Clipboard & { read?: () => Promise<ClipboardItems> } | null)?.read;
  if (!read) return null;
  try {
    const items = await read.call(clipboard);
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const extension = CLIPBOARD_IMAGE_EXTENSION_BY_MIME[imageType.toLowerCase()];
      if (!extension) continue;
      const blob = await item.getType(imageType);
      const dataUrl = await blobToDataUrl(blob);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) continue;
      return {
        base64: dataUrl.slice(comma + 1),
        dataUrl,
        filename: `clipboard-image${extension}`,
        mimeType: imageType,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read clipboard image."));
    reader.readAsDataURL(blob);
  });
}
