/**
 * Browser-safe mock for `window.ade`.
 * Injected only when the Electron preload bridge is absent (i.e. opening the
 * Vite dev server directly in a regular browser).  Every method returns a
 * resolved promise with a sensible default value so the renderer can at least
 * paint the UI without crashing.
 *
 * This mock populates the PR surfaces with realistic data:
 *   Normal  – 5 PRs (open/draft/merged/closed, varied checks/reviews)
 *   Integration – 2 integration PRs with multi-source merge contexts
 *   Rebase  – 6 rebase needs across all urgency categories
 *
 * when a snapshot is exported; otherwise a built-in multi-command / groups / runtime demo is used.
 * Work tab: `sessions` come from the snapshot when present; otherwise built-in terminal session rows
 * (same shape as the export script) so the session list is not empty in Vite-only previews.
 * Linear: `getLinearConnectionStatus` and quick-view mocks stay in sync so the top-bar Linear
 * button appears; data is synthetic unless you use the Electron dev shell (real `window.ade` IPC).
 * For real Linear, sync, and lanes in Vite-only preview, run `npm run dev:vite:live` with
 * `ADE_PROJECT_ROOT` pointing at your ADE project (starts the browser runtime bridge).
 *
 * Optional: generate `browser-mock-ade-snapshot.generated.json` with
 *   npm run export:browser-mock-ade
 * to mirror the current project’s `.ade/ade.db` snapshot. Exported lanes, PRs,
 * rebase/history/session/process rows replace the built-in demo data so
 * browser-only UI work follows the same local state as the desktop app.
 * Files tab: snapshot may include `filesTreeByWorkspace` / `filesContentsByWorkspace`
 * from the export script (disk walk at export time); without them, a small
 * synthetic tree is used per lane workspace id.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BuiltInBrowserAgentAccessSnapshot } from "../shared/types/builtInBrowser";
import type {
  AppControlEventPayload,
  AppControlRecordingStatus,
  AppControlSession,
} from "../shared/types/appControl";
import { getDefaultModelDescriptor } from "../shared/modelRegistry";
import { LEGACY_MAX_CHAT_ATTACHMENT_BYTES } from "../shared/chatAttachmentLimits";
import { normalizeAppPackageChannel, type AppPackageChannel } from "../shared/packageChannel";
import { deriveSmartLinkPreview } from "../shared/smartLinks";
import { createChatLaunchSnapshot, toQueuedMessage } from "../shared/chatLaunch";
// The fixture must demo the link the product actually opens, so it reads the
// same source the host stamps onto every snapshot.
import { usageProviderAccountUrl } from "../shared/types/usage";
import { remoteProjectBindingKey } from "../shared/projectIdentity";
import {
  CHAT_MENTION_KINDS,
  CHAT_MENTION_MAX_PER_KIND,
  CHAT_MENTION_MAX_RESULTS,
  rankChatMentionSuggestions,
} from "../shared/chatMentions";
import {
  DEFAULT_AUTO_UPDATE_PREFERENCES,
  isAdeUsageRangePreset,
  type AdeUsageRangePreset,
  type AutoUpdatePreferences,
  type AgentChatRecoverCodexTurnArgs,
  type AgentChatRecoverCodexTurnResult,
  type AgentChatRecoverTurnArgs,
  type AgentChatRecoverTurnResult,
  type AgentChatPrepareCrossMachineHandoffArgs,
  type AgentChatInterruptResult,
  type ChatMentionKind,
  type ChatMentionSuggestArgs,
  type ChatMentionSuggestion,
  type ChatMentionSuggestResult,
  type GitSyncStatusesArgs,
  type LaneListSnapshot,
  type LaneSummary,
  type OpenProjectBinding,
  type AgentChatRestoreCancelledQueueResult,
  type AgentChatResolveUnprocessedMessageArgs,
  type AgentChatResolveUnprocessedMessageResult,
  MAX_PROMPT_STASHES,
  type PromptStashCreateArgs,
  type PromptStashEntry,
  type RemoteRuntimeActionRequest,
} from "../shared/types";
import type { ChatLaunchEvent, ChatLaunchSnapshot } from "../shared/types/chatLaunch";
import type { AccountSettingRow } from "../shared/types/accountSettings";
import type {
  ApiCredentialGetArgs,
  ApiCredentialListArgs,
  ApiCredentialRemoveArgs,
  ApiCredentialStoreArgs,
  ApiCredentialSummary,
} from "../shared/types/apiCredentials";
import type {
  IosSimulatorDeviceSettings,
  IosSimulatorElementActionKind,
  IosSimulatorElementActionResult,
  IosSimulatorEventLogPage,
} from "../shared/types/iosSimulator";
import {
  ADE_WELCOME_VIDEO_ID,
  ADE_WELCOME_VIDEO_VERSION,
} from "../shared/welcomeVideo";
import {
  INERT_KEEP_AWAKE_SNAPSHOT,
  type KeepAwakeSnapshot,
} from "../shared/types/keepAwake";
import { createMockExternalSessionsApi } from "./browserMockExternalSessions";
import { attachBrowserRuntimeBridge } from "./browserRuntimeBridge";
import { rendererPlatformAttribute } from "./lib/platform";
import { applyHostedWebZoom } from "./lib/webZoom";
import { getStoredZoomLevel, zoomFactorForDisplay, zoomFactorForLevel } from "./lib/zoom";

// The browser preview holds no power locks, so it reports the honest default.
const MOCK_KEEP_AWAKE_SNAPSHOT = INERT_KEEP_AWAKE_SNAPSHOT;

const noop = () => () => {};
/**
 * The owner's machine as the Apple picker sees it: one iOS runtime, five
 * devices, two booted. Used by the Vite-only preview so the page can be looked
 * at in a browser instead of only in a built Electron app.
 */
const BROWSER_MOCK_SIMULATORS = [
  { udid: "pro", name: "iPhone 17 Pro", runtime: "iOS 26.3", state: "Booted", isAvailable: true, family: "iphone", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
  { udid: "e", name: "iPhone 17e", runtime: "iOS 26.3", state: "Shutdown", isAvailable: true, family: "iphone", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17e" },
  { udid: "repro", name: "ADE Repro", runtime: "iOS 26.3", state: "Booted", isAvailable: true, family: "iphone", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro" },
  { udid: "pad", name: "iPad Air 11-inch (M4)", runtime: "iOS 26.3", state: "Shutdown", isAvailable: true, family: "ipad", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4" },
  { udid: "pad13", name: "iPad Air 13-inch (M4)", runtime: "iOS 26.3", state: "Shutdown", isAvailable: true, family: "ipad", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-13-inch-M4" },
] as const;

const resolved =
  <T>(v: T) =>
  async () =>
    v;
/**
 * In-memory "Agents can use the ADE browser" for the browser-mock renderer.
 * `window.__adeMockBrowserAgentPrompt()` opens a sample prompt so the dialog
 * can be looked at without a live agent.
 */
function createMockBrowserAgentAccess() {
  type Snapshot = BuiltInBrowserAgentAccessSnapshot;
  let snapshot: Snapshot = { mode: "all", laneGrants: [], chatGrants: [], prompts: [] };
  const listeners = new Set<(next: Snapshot) => void>();
  const emit = () => {
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__adeMockBrowserAgentPrompt = (mode: "lanes" | "chats" = "lanes") => {
      snapshot = {
        ...snapshot,
        mode,
        prompts: [...snapshot.prompts, {
          id: `mock-${Date.now()}`,
          chatSessionId: "3f1c2a9e-0000-4000-8000-000000000001",
          chatTitle: "Fix the sign-in redirect",
          laneId: "7b2d4e10-0000-4000-8000-000000000002",
          laneName: "auth-refactor",
          projectRoot: "/Users/me/Projects/web-app",
          canAllowLane: mode === "lanes",
          canAllowChat: true,
          requestedAt: new Date().toISOString(),
        }],
      };
      emit();
    };
  }
  return {
    get: async () => snapshot,
    setMode: async (mode: Snapshot["mode"]) => {
      snapshot = { ...snapshot, mode, prompts: mode === "all" ? [] : snapshot.prompts };
      return emit();
    },
    answer: async (promptId: string, answer: string) => {
      const prompt = snapshot.prompts.find((entry) => entry.id === promptId);
      if (!prompt) return snapshot;
      const now = new Date().toISOString();
      snapshot = {
        mode: answer === "all" ? "all" : snapshot.mode,
        laneGrants: answer === "lane" && prompt.laneId
          ? [{ projectRoot: prompt.projectRoot, laneId: prompt.laneId, laneName: prompt.laneName, grantedAt: now }, ...snapshot.laneGrants]
          : snapshot.laneGrants,
        chatGrants: answer === "chat" && prompt.chatSessionId
          ? [{ chatSessionId: prompt.chatSessionId, chatTitle: prompt.chatTitle, laneName: prompt.laneName, grantedAt: now }, ...snapshot.chatGrants]
          : snapshot.chatGrants,
        prompts: snapshot.prompts.filter((entry) => entry.id !== promptId),
      };
      return emit();
    },
    revoke: async (args: { kind: string; laneId?: string; chatSessionId?: string }) => {
      snapshot = {
        ...snapshot,
        laneGrants: args.kind === "all" ? [] : snapshot.laneGrants.filter((grant) => !(args.kind === "lane" && grant.laneId === args.laneId)),
        chatGrants: args.kind === "all" ? [] : snapshot.chatGrants.filter((grant) => !(args.kind === "chat" && grant.chatSessionId === args.chatSessionId)),
      };
      return emit();
    },
    onChange: (cb: (next: Snapshot) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const resolvedArg =
  <T>(v: T) =>
  async (_a: any) =>
    v;
/** Mirrors `createLoginImportUnavailableStub` in the hosted web adapter. */
const LOGIN_IMPORT_UNAVAILABLE = {
  ok: false as const,
  sourceId: "",
  status: "unsupported" as const,
  reason: "Login import needs the ADE desktop app on the machine holding the browser.",
  settingsPaneId: null,
};
const resolvedArg2 =
  <T>(v: T) =>
  async (_a: any, _b: any) =>
    v;
/* ── chatLaunch (browser preview) ─────────────────────────────────────────
   A small simulator so the Vite preview shows a new-lane launch moving:
   fetch → check out files (with %) → start agent, a few hundred ms apart. A
   CLI launch parks at awaiting-client like the real brain. */
const browserMockChatLaunches = new Map<string, ChatLaunchSnapshot>();
const browserMockChatLaunchListeners = new Set<(event: ChatLaunchEvent) => void>();

function emitBrowserMockChatLaunch(launch: ChatLaunchSnapshot): ChatLaunchSnapshot {
  const next = { ...launch, sequence: launch.sequence + 1, updatedAt: new Date().toISOString() };
  browserMockChatLaunches.set(next.launchId, next);
  for (const listener of browserMockChatLaunchListeners) listener({ type: "launch-updated", launch: next });
  return next;
}

function advanceBrowserMockChatLaunch(launchId: string): void {
  const launch = browserMockChatLaunches.get(launchId);
  if (!launch || launch.phase !== "running") return;
  const now = new Date().toISOString();
  const stages = launch.stages.map((stage) => ({ ...stage }));
  const running = stages.find((stage) => stage.status === "running");
  if (running?.id === "checkout" && (running.percent ?? 0) < 100) {
    running.percent = Math.min(100, (running.percent ?? 0) + 25);
    running.detail = "4,917 files";
    emitBrowserMockChatLaunch({ ...launch, stages, laneCreated: true, worktreePath: `/tmp/${launch.laneName}` });
    window.setTimeout(() => advanceBrowserMockChatLaunch(launchId), 260);
    return;
  }
  if (running) {
    running.status = "done";
    running.endedAt = now;
    if (running.id === "fetch") running.detail = "origin/main at 807fb2c";
  }
  const next = stages.find((stage) => stage.status === "pending");
  if (next && !(next.id === "agent" && launch.kind === "cli")) {
    next.status = "running";
    next.startedAt = now;
    if (next.id === "checkout") next.percent = 0;
    emitBrowserMockChatLaunch({ ...launch, stages, laneCreated: launch.laneCreated || next.id !== "fetch" });
    window.setTimeout(() => advanceBrowserMockChatLaunch(launchId), 420);
    return;
  }
  if (next && launch.kind === "cli") {
    emitBrowserMockChatLaunch({ ...launch, stages, phase: "awaiting-client", laneCreated: true });
    return;
  }
  emitBrowserMockChatLaunch({
    ...launch,
    stages,
    phase: "completed",
    laneCreated: true,
    sessionCreated: true,
    agentStarted: true,
    endedAt: now,
    queuedMessages: [],
  });
}

function startBrowserMockChatLaunch(args: any = {}): ChatLaunchSnapshot {
  const existing = browserMockChatLaunches.get(String(args.launchId));
  if (existing) return existing;
  const now = new Date().toISOString();
  const base = createChatLaunchSnapshot({
    launch: { ...args, launchId: String(args.launchId) },
    laneId: String(args.laneId ?? `lane-${Date.now()}`),
    laneName: String(args.laneName ?? "New lane"),
    includeFetch: true,
    includeEnvironment: false,
    nowIso: now,
  });
  const launch: ChatLaunchSnapshot = {
    ...base,
    branchRef: `refs/heads/ade/${base.launchId.slice(0, 8)}`,
    baseRef: base.baseRef ?? "origin/main",
    stages: base.stages.map((stage, index) => (index === 0 ? { ...stage, status: "running", startedAt: now } : stage)),
  };
  browserMockChatLaunches.set(launch.launchId, launch);
  window.setTimeout(() => advanceBrowserMockChatLaunch(launch.launchId), 420);
  return launch;
}

/**
 * Reads a preview-only override from the URL (plain query or hash query) and
 * remembers it in localStorage so it survives in-app navigation.
 */
function browserMockOverride(param: string, storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const search = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const hashQueryIndex = hash.indexOf("?");
    const hashSearch = new URLSearchParams(
      hashQueryIndex >= 0 ? hash.slice(hashQueryIndex + 1) : "",
    );
    const fromUrl = search.get(param) ?? hashSearch.get(param);
    if (fromUrl) {
      window.localStorage?.setItem(storageKey, fromUrl);
      return fromUrl;
    }
    return window.localStorage?.getItem(storageKey) ?? null;
  } catch {
    return null;
  }
}

/**
 * The mock is stable by default so the browser preview matches a normal build.
 * Override it to exercise the channel badge without packaging anything:
 *   http://localhost:5173/#/work?adeChannel=beta   (or ?adeChannel=beta)
 *   localStorage.setItem("ade.mock.packageChannel", "alpha")
 */
function browserMockPackageChannel(): AppPackageChannel {
  return normalizeAppPackageChannel(
    browserMockOverride("adeChannel", "ade.mock.packageChannel"),
  );
}

/**
 * Host platform the preview should pretend to run on. Defaults to the real
 * browser's platform (so the preview matches the machine you are on) and can be
 * forced to exercise platform-gated UI — the Windows beta notice above all:
 *   http://localhost:5173/?adePlatform=win32   (or darwin / linux)
 *   localStorage.setItem("ade.mock.platform", "darwin")
 */
function browserMockPlatform(): string {
  const forced = browserMockOverride("adePlatform", "ade.mock.platform");
  const normalized = forced?.trim().toLowerCase();
  if (normalized === "win32" || normalized === "darwin" || normalized === "linux") {
    return normalized;
  }
  return rendererPlatformAttribute();
}

/* ── App Control (browser preview) ───────────────────────────────────────
   A stateful mock so the App Control pane, its strip, the recording chrome and
   the floating player can be looked at in the Vite preview. Pick the starting
   state with the URL (plain or hash query), remembered in localStorage:

     ?adeAppControl=off         No app: the Off card with Launch and Attach
     ?adeAppControl=live        An attached app with a live frame (default)
     ?adeAppControl=recording   The same app, recording for 12 seconds
     ?adeAppControl=permission  Record refused: Screen Recording is off

   Launch or Attach from the Off card goes live, Stop goes back to Off, and
   Record / Stop recording round-trip with a "Saved to proof" receipt. */

type MockAppControlState = "off" | "live" | "recording" | "permission";

function browserMockAppControlState(): MockAppControlState {
  const raw = browserMockOverride("adeAppControl", "ade.mock.appControl")?.trim().toLowerCase();
  return raw === "off" || raw === "recording" || raw === "permission" ? raw : "live";
}

/** A believable app window, drawn as SVG and rasterized once for frames. */
function mockAppControlSvg(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#0f1115"/>
  <rect width="1280" height="44" fill="#171a21"/>
  <circle cx="24" cy="22" r="6" fill="#ff5f57"/><circle cx="44" cy="22" r="6" fill="#febc2e"/><circle cx="64" cy="22" r="6" fill="#28c840"/>
  <text x="640" y="27" fill="#9aa3b2" font-family="-apple-system,Segoe UI,sans-serif" font-size="14" text-anchor="middle">ADE Playground</text>
  <rect x="0" y="44" width="240" height="756" fill="#13161c"/>
  <g font-family="-apple-system,Segoe UI,sans-serif" font-size="14" fill="#c9d1dc">
    <rect x="12" y="64" width="216" height="32" rx="6" fill="#232838"/>
    <text x="28" y="85">Inbox</text><text x="28" y="125" fill="#8b94a3">Drafts</text><text x="28" y="161" fill="#8b94a3">Settings</text>
  </g>
  <g font-family="-apple-system,Segoe UI,sans-serif">
    <text x="288" y="112" fill="#e6ebf2" font-size="28" font-weight="600">Sign in to continue</text>
    <text x="288" y="144" fill="#8b94a3" font-size="15">Use the account you set up in the playground.</text>
    <rect x="288" y="180" width="440" height="44" rx="8" fill="#171a21" stroke="#2c3240"/>
    <text x="304" y="208" fill="#6b7383" font-size="15">you@example.com</text>
    <rect x="288" y="240" width="440" height="44" rx="8" fill="#171a21" stroke="#2c3240"/>
    <text x="304" y="268" fill="#6b7383" font-size="15">Password</text>
    <rect x="288" y="308" width="140" height="42" rx="8" fill="#7c6cf6"/>
    <text x="358" y="335" fill="#ffffff" font-size="15" font-weight="600" text-anchor="middle">Sign in</text>
  </g>
  <rect x="820" y="96" width="400" height="260" rx="12" fill="#171a21" stroke="#232838"/>
  <text x="844" y="132" fill="#c9d1dc" font-family="-apple-system,Segoe UI,sans-serif" font-size="15" font-weight="600">Activity</text>
  <rect x="844" y="152" width="352" height="10" rx="5" fill="#232838"/><rect x="844" y="152" width="220" height="10" rx="5" fill="#7c6cf6"/>
  <rect x="844" y="180" width="352" height="10" rx="5" fill="#232838"/><rect x="844" y="180" width="140" height="10" rx="5" fill="#38bdf8"/>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function createMockAppControl() {
  type Listener = (event: AppControlEventPayload) => void;
  const listeners = new Set<Listener>();
  let state = browserMockAppControlState();
  let laneId: string | null = null;
  let recordingStartedAt: string | null = state === "recording" ? new Date(Date.now() - 12_000).toISOString() : null;
  let pngBase64: string | null = null;
  let frameTimer: number | null = null;
  const svgDataUrl = mockAppControlSvg();

  const session = (): AppControlSession => ({
    id: "mock-app-control-session",
    appKind: "electron",
    label: "ADE Playground",
    projectRoot: MOCK_PROJECT.rootPath,
    laneId,
    cwd: MOCK_PROJECT.rootPath,
    command: "pnpm dev",
    pid: 4242,
    terminalSessionId: null,
    terminalPtyId: null,
    cdpPort: 9222,
    cdpEndpoint: "ws://127.0.0.1:9222/devtools/page/mock",
    cdpTargetId: "mock-target",
    provider: "cdp",
    driver: "cdp",
    chatSessionId: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    connectedAt: new Date(Date.now() - 58_000).toISOString(),
    status: "connected",
    lastError: null,
    lastObservationId: null,
    lastTraceEntryId: null,
  });
  const activeSession = () => (state === "off" ? null : session());
  const permissionsDenied = { screenRecording: "denied", accessibility: "granted" } as const;
  const recordingStatus = (): AppControlRecordingStatus => ({
    laneId: laneId ?? "",
    running: state === "recording",
    startedAt: state === "recording" ? recordingStartedAt : null,
    filePath: null,
    durationMs: null,
    caption: state === "recording" ? "App Control recording of ADE Playground" : null,
    engine: "window-capture",
    lastError: state === "permission" ? "Screen Recording is off for ADE." : null,
    permissions: state === "permission" ? permissionsDenied : null,
  });
  const emit = (event: AppControlEventPayload) => {
    for (const listener of [...listeners]) listener(event);
  };
  const rasterize = async (): Promise<string | null> => {
    if (pngBase64) return pngBase64;
    try {
      const image = new Image();
      image.src = svgDataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 800;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      pngBase64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? null;
    } catch {
      pngBase64 = null;
    }
    return pngBase64;
  };
  const emitFrame = async () => {
    if (state === "off" || !laneId) return;
    const data = await rasterize();
    if (!data) return;
    emit({
      type: "frame",
      laneId,
      frame: {
        sessionId: "mock-app-control-session",
        laneId,
        cdpTargetId: "mock-target",
        data,
        mimeType: "image/jpeg",
        width: 1280,
        height: 800,
        scale: 1,
        viewportWidth: 1280,
        viewportHeight: 800,
        capturedAt: new Date().toISOString(),
      },
    });
  };
  // A screencast only while something listens, once a second: enough for the
  // "live" look without a 30 fps loop in a preview tab.
  const syncFrames = () => {
    if (listeners.size > 0 && state !== "off") {
      if (frameTimer == null) frameTimer = window.setInterval(() => void emitFrame(), 1_000);
      void emitFrame();
    } else if (frameTimer != null) {
      window.clearInterval(frameTimer);
      frameTimer = null;
    }
  };
  const noteLane = (args: any) => {
    const next = typeof args?.laneId === "string" && args.laneId ? args.laneId : null;
    if (next) laneId = next;
  };
  const goLive = async (args: any) => {
    noteLane(args);
    state = "live";
    emit({ type: "session-started", laneId, session: session() });
    syncFrames();
    return session();
  };

  return {
    getStatus: async (args?: any) => {
      noteLane(args);
      const current = activeSession();
      return {
        platform: "darwin" as NodeJS.Platform,
        supported: true,
        laneId,
        activeSession: current,
        sessions: current ? [current] : [],
        providers: [{ provider: "cdp" as const, available: true }],
      };
    },
    launch: goLive,
    launchInTerminal: goLive,
    connect: goLive,
    stop: async (args?: any) => {
      noteLane(args);
      const previous = activeSession();
      state = "off";
      recordingStartedAt = null;
      emit({ type: "session-stopped", laneId, previousSession: previous });
      syncFrames();
      return { ok: true as const, previousSession: previous };
    },
    focusWindow: resolvedArg({ ok: true as const }),
    minimizeWindow: resolvedArg({ ok: true as const }),
    screenshot: async () => ({
      sessionId: "mock-app-control-session",
      capturedAt: new Date().toISOString(),
      width: 1280,
      height: 800,
      dataUrl: svgDataUrl,
    }),
    getSnapshot: async (args?: any) => {
      noteLane(args);
      return {
        session: activeSession(),
        capturedAt: new Date().toISOString(),
        screenshot: state === "off" ? null : {
          sessionId: "mock-app-control-session",
          cdpTargetId: "mock-target",
          capturedAt: new Date().toISOString(),
          width: 1280,
          height: 800,
          dataUrl: svgDataUrl,
        },
        screen: { width: 1280, height: 800, scale: 1, viewportWidth: 1280, viewportHeight: 800, scaleX: 1, scaleY: 1 },
        elements: [],
        hitElement: null,
        providers: [{ provider: "cdp" as const, available: true, elementCount: 0 }],
        url: "http://localhost:5173/sign-in",
        title: "ADE Playground",
      };
    },
    inspectPoint: resolvedArg({} as any),
    selectPoint: resolvedArg({} as any),
    click: resolvedArg({ ok: true as const }),
    typeText: resolvedArg({ ok: true as const }),
    scroll: resolvedArg({ ok: true as const }),
    dispatchKey: resolvedArg({ ok: true as const }),
    listTargets: async () => (state === "off" ? [] : [
      { id: "mock-target", title: "ADE Playground", url: "http://localhost:5173/sign-in", type: "page", active: true },
    ]),
    attachToTarget: async () => session(),
    listDrivers: async () => ({
      platform: "darwin" as NodeJS.Platform,
      activeDriver: "cdp" as const,
      drivers: [
        { driver: "cdp" as const, status: "available" as const, reason: null, implemented: true },
        {
          driver: "computer_use" as const,
          status: "unavailable" as const,
          reason: "The computer-use App Control driver is not built yet.",
          implemented: false,
        },
      ],
    }),
    observe: resolvedArg({} as any),
    getTrace: async () => ({ sessionId: activeSession()?.id ?? null, entries: [] }),
    windows: async () => ({ sessionId: activeSession()?.id ?? null, activeTargetId: "mock-target", windows: [] }),
    switchWindow: async () => ({ sessionId: activeSession()?.id ?? null, activeTargetId: "mock-target", windows: [] }),
    getRecordingStatus: async (args?: any) => {
      noteLane(args);
      return recordingStatus();
    },
    getLatestFrame: async () => null,
    startRecording: async (args?: any) => {
      noteLane(args);
      if (state === "permission") {
        const status = recordingStatus();
        emit({ type: "recording-changed", laneId: laneId ?? "", status });
        return status;
      }
      state = "recording";
      recordingStartedAt = new Date().toISOString();
      const status = { ...recordingStatus(), caption: args?.caption ?? null };
      emit({ type: "recording-changed", laneId: laneId ?? "", status });
      return status;
    },
    stopRecording: async (args?: any) => {
      noteLane(args);
      const startedAt = recordingStartedAt;
      state = "live";
      recordingStartedAt = null;
      const durationMs = startedAt ? Math.max(1_000, Date.now() - Date.parse(startedAt)) : 0;
      const status: AppControlRecordingStatus = {
        ...recordingStatus(),
        running: false,
        filePath: `${MOCK_PROJECT.rootPath}/.ade/artifacts/app-control-recording.mp4`,
        durationMs,
        wallDurationMs: durationMs,
        idleCutMs: 0,
        bytes: 3_400_000,
        caption: "App Control recording of ADE Playground",
        proofArtifactId: "mock-app-control-proof",
        chatSessionId: args?.chatSessionId ?? null,
      };
      emit({ type: "recording-changed", laneId: laneId ?? "", status });
      return status;
    },
    captureProof: async (args?: any) => {
      noteLane(args);
      return {
        artifactId: "mock-app-control-still",
        filePath: `${MOCK_PROJECT.rootPath}/.ade/cache/app-control-observations/mock/obs-mock.png`,
        width: 1280,
        height: 800,
        caption: args?.caption ?? "App Control screenshot · ADE Playground",
        laneId: laneId ?? "",
        chatSessionId: args?.chatSessionId ?? null,
        artifacts: [],
        links: [],
      };
    },
    onEvent: (listener: Listener) => {
      listeners.add(listener);
      // The permission state is the answer a refused start gave: say it once
      // to whoever subscribes, so the card is on screen without a click.
      if (state === "permission" && laneId) {
        const status = recordingStatus();
        window.setTimeout(() => listener({ type: "recording-changed", laneId: laneId ?? "", status }), 0);
      }
      syncFrames();
      return () => {
        listeners.delete(listener);
        syncFrames();
      };
    },
  };
}

const DEFAULT_BROWSER_MOCK_CODEX_MODEL =
  getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-6-astra";
const DEFAULT_BROWSER_MOCK_CLAUDE_MODEL =
  getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-5";
const BROWSER_MOCK_PREVIEW_CAPABILITY_UNSUPPORTED = {
  platform: "darwin",
  supported: false,
  docsUrl: "https://developer.apple.com/documentation/xcode",
  xcodeVersion: null,
  mcpbridgeAvailable: false,
  xcodeRunning: false,
  xcodeWindows: [],
  selectedWindow: null,
  setupSteps: ["Browser preview cannot manage Xcode."],
  error: "Browser preview cannot manage Xcode.",
  checkedAt: "1970-01-01T00:00:00.000Z",
} as const;
const BROWSER_MOCK_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l5mS9QAAAABJRU5ErkJggg==";

const BUILTIN_MOCK_PROJECT = {
  id: "browser-mock",
  name: "Browser Preview",
  displayName: "Browser Preview",
  rootPath: "/tmp/mock",
  gitRemoteUrl: "https://github.com/acme/ade",
  gitDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

const adeDbSnapshotByPath = import.meta.glob<any>(
  "./browser-mock-ade-snapshot.generated.json",
  {
    eager: true,
    import: "default",
  },
);

const ADE_DB_SNAPSHOT =
  adeDbSnapshotByPath["./browser-mock-ade-snapshot.generated.json"] ?? null;
const USE_ADE_DB_SNAPSHOT = Boolean(ADE_DB_SNAPSHOT?.project);
const USE_STATS_DASHBOARD_SNAPSHOT = USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.statsDashboardVersion === 1;

const MOCK_PROJECT =
  USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.project
    ? {
        ...BUILTIN_MOCK_PROJECT,
        id: ADE_DB_SNAPSHOT.project.id,
        name: ADE_DB_SNAPSHOT.project.name,
        displayName: ADE_DB_SNAPSHOT.project.name,
        rootPath: ADE_DB_SNAPSHOT.project.rootPath,
        gitDefaultBranch:
          ADE_DB_SNAPSHOT.project.gitDefaultBranch ??
          BUILTIN_MOCK_PROJECT.gitDefaultBranch,
        createdAt:
          ADE_DB_SNAPSHOT.project.createdAt ?? BUILTIN_MOCK_PROJECT.createdAt,
      }
    : BUILTIN_MOCK_PROJECT;

// ── Timestamps ────────────────────────────────────────────────
const now = new Date().toISOString();

/**
 * The two accounts every machine has: the pre-existing Claude and Codex logins
 * the real store synthesizes on read. Mutable so the mock's create/rename/
 * remove handlers round-trip in the preview instead of looking broken.
 */
const mockProviderInstances: Array<{
  id: string;
  provider: "claude" | "codex";
  label: string;
  accentColor?: string;
  configHome: string;
  isDefault: boolean;
  createdAt: string;
  account?: { email?: string; plan?: string };
  signedIn: boolean;
}> = [
  {
    id: "claude",
    provider: "claude",
    label: "Default",
    configHome: "/mock/.claude",
    isDefault: true,
    createdAt: new Date(0).toISOString(),
    account: { email: "ada.lovelace@example.com", plan: "Claude Max 20x" },
    signedIn: true,
  },
  // A second Claude sign-in: the preview needs one to show the states that
  // only exist with more than one account (smart balance, the per-account
  // usage rows, a preset that names which account it launches on).
  {
    id: "claude-work",
    provider: "claude",
    label: "Work",
    accentColor: "#5ba8d9",
    configHome: "/mock/.ade/provider-homes/claude/work",
    isDefault: false,
    createdAt: new Date(0).toISOString(),
    account: { email: "jo.martin@example.com", plan: "Claude Pro" },
    signedIn: true,
  },
  {
    id: "codex",
    provider: "codex",
    label: "Default",
    configHome: "/mock/.codex",
    isDefault: true,
    createdAt: new Date(0).toISOString(),
    account: { email: "dev@example.com", plan: "ChatGPT Pro 20x Subscription" },
    signedIn: true,
  },
];

/**
 * Provider API keys, stateful for the same reason the accounts above are: the
 * keys panel adds, replaces and deletes rows, and a frozen stub would make
 * every one of those look broken in the Vite-only preview. One Anthropic row
 * is seeded from the environment so the read-only "managed outside ADE" case
 * is visible without anyone having to set a variable.
 */
const mockApiCredentials: ApiCredentialSummary[] = [
  {
    provider: "anthropic",
    credentialId: "default",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    source: "env",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    maskedTail: "••••3c1x",
  },
];

const mockProviderInstanceSettings: Record<
  "claude" | "codex",
  { smartBalance: boolean; autoStartWindows: boolean }
> = {
  claude: { smartBalance: false, autoStartWindows: false },
  codex: { smartBalance: false, autoStartWindows: false },
};

function mockProviderInstanceById(id: string) {
  const instance = mockProviderInstances.find((entry) => entry.id === id);
  if (!instance) throw new Error(`No provider account with id ${JSON.stringify(id)}.`);
  return instance;
}

function mockProviderInstanceLoginCommand(instance: { provider: "claude" | "codex"; configHome: string }) {
  return instance.provider === "claude"
    ? { command: "claude", args: ["auth", "login"], env: { CLAUDE_CONFIG_DIR: instance.configHome } }
    : { command: "codex", args: ["login"], env: { CODEX_HOME: instance.configHome } };
}

// ── iOS simulator preview stubs ───────────────────────────────
// The browser preview has no simulator, so every device call answers with the
// same inert value. One definition per shape keeps the methods that share it
// from drifting apart, and the real types catch a shape that no longer
// compiles against the preload contract.
const BROWSER_MOCK_IOS_DEVICE_SETTINGS: IosSimulatorDeviceSettings = {
  deviceUdid: "browser-mock-device",
  appearance: "unknown",
  contentSize: "large",
  accessibility: {
    "increase-contrast": null,
    "reduce-motion": null,
    "reduce-transparency": null,
    "button-shapes": null,
    "bold-text": null,
    "invert-colors": null,
    grayscale: null,
    "voice-over": null,
  },
  location: null,
  statusBarOverridden: false,
  readAt: now,
};

const BROWSER_MOCK_IOS_LOG_PAGE: IosSimulatorEventLogPage = {
  deviceUdid: null,
  running: false,
  rows: [],
  cursor: 0,
  dropped: 0,
  lastError: null,
};

// Element actions differ only in which action is being reported back.
const browserMockIosElementResult = (
  action: IosSimulatorElementActionKind,
): IosSimulatorElementActionResult => ({
  ok: false,
  action,
  match: null,
  matchCount: 0,
  message: "Browser preview has no iOS simulator.",
  waitedMs: null,
  effect: { status: "not_checked", reason: "nothing was sent" },
});

const WELCOME_VIDEO_STORAGE_KEY = "ade.browserMock.welcomeVideoState";

function readBrowserMockWelcomeVideoState() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WELCOME_VIDEO_STORAGE_KEY) ?? "null") as {
      videoId?: unknown;
      version?: unknown;
      completedAt?: unknown;
      dismissedAt?: unknown;
    } | null;
    if (parsed?.videoId === ADE_WELCOME_VIDEO_ID && parsed.version === ADE_WELCOME_VIDEO_VERSION) {
      return {
        videoId: ADE_WELCOME_VIDEO_ID,
        version: ADE_WELCOME_VIDEO_VERSION,
        completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
        dismissedAt: typeof parsed.dismissedAt === "string" ? parsed.dismissedAt : null,
      };
    }
  } catch {
    // Ignore malformed preview-only state.
  }
  return {
    videoId: ADE_WELCOME_VIDEO_ID,
    version: ADE_WELCOME_VIDEO_VERSION,
    completedAt: null,
    dismissedAt: null,
  };
}

function writeBrowserMockWelcomeVideoState(state: ReturnType<typeof readBrowserMockWelcomeVideoState>) {
  try {
    window.localStorage.setItem(WELCOME_VIDEO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser preview storage can be unavailable.
  }
}

const MOCK_LINEAR_CONNECTION = {
  tokenStored: true,
  connected: true,
  viewerId: "mock-linear-user",
  viewerName: "Mock Linear User",
  organizationId: "mock-linear-org",
  organizationName: "ADE",
  organizationUrlKey: "ade",
  organizationLogoUrl: null,
  projectCount: 1,
  projectPreview: ["Desktop polish"],
  checkedAt: now,
  authMode: "manual" as const,
  oauthAvailable: true,
  tokenExpiresAt: null,
  message: null,
};

const MOCK_LINEAR_PROJECTS = [
  {
    id: "mock-linear-project",
    name: "Desktop polish",
    slug: "desktop-polish",
    teamName: "ADE",
    teamKey: "ADE",
    icon: null,
    color: "#5E6AD2",
  },
];

const MOCK_LINEAR_ISSUES = [
  {
    id: "mock-linear-issue-1",
    identifier: "ADE-101",
    title: "Polish Work tab header layout",
    description: "Align tabs, tools toggle, and lane bands in the Work chrome.",
    url: "https://linear.app/ade/issue/ADE-101/polish-work-tab-header-layout",
    projectId: "mock-linear-project",
    projectSlug: "desktop-polish",
    projectName: "Desktop polish",
    teamId: "mock-linear-team",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "mock-linear-state-started",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: [],
    metadataTags: [],
    assigneeId: "mock-linear-user",
    assigneeName: "Mock Linear User",
    creatorId: "mock-linear-user",
    creatorName: "Mock Linear User",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    dueDate: null,
    estimate: 3,
    archivedAt: null,
    completedAt: null,
    canceledAt: null,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    raw: {},
  },
  {
    id: "mock-linear-issue-2",
    identifier: "ADE-102",
    title: "Chat actions drawer parity",
    description: "Unify Proof, Agents, and Handoff into one tabbed drawer.",
    url: "https://linear.app/ade/issue/ADE-102/chat-actions-drawer-parity",
    projectId: "mock-linear-project",
    projectSlug: "desktop-polish",
    projectName: "Desktop polish",
    teamId: "mock-linear-team",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "mock-linear-state-todo",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 3,
    priorityLabel: "medium",
    labels: [],
    metadataTags: [],
    assigneeId: null,
    assigneeName: null,
    creatorId: "mock-linear-user",
    creatorName: "Mock Linear User",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    dueDate: null,
    estimate: 2,
    archivedAt: null,
    completedAt: null,
    canceledAt: null,
    startedAt: null,
    createdAt: now,
    updatedAt: now,
    raw: {},
  },
];

const MOCK_LINEAR_PICKER = {
  projects: MOCK_LINEAR_PROJECTS,
  users: [
    {
      id: "mock-linear-user",
      name: "Mock Linear User",
      displayName: "Mock Linear User",
      email: "mock@example.com",
      avatarUrl: null,
      active: true,
    },
  ],
  states: [
    { id: "mock-linear-state-started", name: "In Progress", type: "started", teamId: "mock-linear-team" },
    { id: "mock-linear-state-todo", name: "Todo", type: "unstarted", teamId: "mock-linear-team" },
  ],
};

/** Browser mock lane health; matches `LaneHealthCheck` in shared types. */
function mockBrowserLaneHealth(laneId: string) {
  return {
    laneId,
    status: "unknown" as const,
    portResponding: false,
    respondingPort: null as number | null,
    proxyRouteActive: false,
    fallbackMode: false,
    lastCheckedAt: now,
    issues: [] as Array<{
      type:
        | "port-unresponsive"
        | "proxy-route-missing"
        | "port-conflict"
        | "env-init-failed";
      message: string;
      actionLabel?: string;
      actionType?:
        | "reassign-port"
        | "restart-proxy"
        | "reinit-env"
        | "enable-fallback"
        | "refresh-preview";
    }>,
  };
}

const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();
const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
const threeDaysAgo = new Date(Date.now() - 259200000).toISOString();
const fourHoursFromNow = new Date(Date.now() + 4 * 3600000).toISOString();

// ── Lane defaults (fields required by LaneSummary) ────────────
function makeLane(
  id: string,
  name: string,
  branchRef: string,
  opts?: Partial<any>,
): any {
  return {
    id,
    name,
    description: null,
    laneType: id === "lane-main" ? "primary" : "worktree",
    baseRef: "main",
    branchRef,
    worktreePath: `/tmp/mock/${id}`,
    attachedRootPath: null,
    parentLaneId: id === "lane-main" ? null : "lane-main",
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt: twoDaysAgo,
    archivedAt: null,
    ...opts,
  };
}

// ── Mock Lanes ────────────────────────────────────────────────
const BUILTIN_MOCK_LANES: any[] = [
  // Primary
  makeLane("lane-main", "main", "refs/heads/main"),
  // Normal PR lanes
  makeLane("lane-auth", "feature/auth-flow", "refs/heads/feature/auth-flow"),
  makeLane(
    "lane-dashboard",
    "feature/dashboard-v2",
    "refs/heads/feature/dashboard-v2",
  ),
  makeLane(
    "lane-api",
    "feature/api-refactor",
    "refs/heads/feature/api-refactor",
  ),
  makeLane(
    "lane-perf",
    "fix/perf-regression",
    "refs/heads/fix/perf-regression",
  ),
  makeLane(
    "lane-onboard",
    "feature/onboarding-wizard",
    "refs/heads/feature/onboarding-wizard",
  ),
  // Integration PR lanes
  makeLane("lane-search", "feature/search-v2", "refs/heads/feature/search-v2"),
  makeLane(
    "lane-analytics",
    "feature/analytics",
    "refs/heads/feature/analytics",
  ),
  makeLane("lane-i18n", "feature/i18n", "refs/heads/feature/i18n"),
  makeLane(
    "lane-a11y",
    "feature/accessibility",
    "refs/heads/feature/accessibility",
  ),
];

/** Work tab preview when the snapshot omits `sessions` (matches export script row shape). */
const BUILTIN_MOCK_SESSIONS: any[] = [
  {
    id: "mock-session-claude-1",
    laneId: "lane-main",
    laneName: "main",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: "Polish Run and Work browser mocks",
    toolType: "claude-chat",
    title: "Claude · Browser preview parity",
    status: "running",
    startedAt: oneHourAgo,
    endedAt: null,
    archivedAt: null,
    exitCode: null,
    transcriptPath: ".ade/transcripts/mock-session-claude-1.chat.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: "Planning UI tweaks…",
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    resumeMetadata: {
      provider: "claude",
      targetKind: "session",
      targetId: "mock-session-claude-1",
      launch: {},
    },
  },
  {
    id: "mock-session-codex-1",
    laneId: "lane-auth",
    laneName: "feature/auth-flow",
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: "Tighten agent chat IPC merge path",
    toolType: "codex-chat",
    title: "Codex · IPC merge review",
    status: "completed",
    startedAt: yesterday,
    endedAt: oneHourAgo,
    archivedAt: null,
    exitCode: 0,
    transcriptPath: ".ade/transcripts/mock-session-codex-1.chat.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: "Done.",
    summary: "Reviewed session merge logic.",
    runtimeState: "exited",
    resumeCommand: null,
    resumeMetadata: {
      provider: "codex",
      targetKind: "session",
      targetId: "mock-session-codex-1",
      launch: {},
    },
  },
  {
    id: "mock-session-shell-1",
    laneId: "lane-main",
    laneName: "main",
    ptyId: "pty-mock-1",
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: null,
    toolType: "shell",
    title: "npm run typecheck",
    status: "completed",
    startedAt: twoDaysAgo,
    endedAt: yesterday,
    archivedAt: null,
    exitCode: 0,
    transcriptPath: ".ade/transcripts/mock-session-shell-1.log",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: "> tsc --noEmit\n",
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
    resumeMetadata: null,
  },
];

function buildMockLanesFromAdeSnapshot(laneRows: any[]): any[] {
  const childCounts = new Map<string, number>();
  for (const row of laneRows) {
    const pid = row.parentLaneId;
    if (typeof pid === "string" && pid.length > 0) {
      childCounts.set(pid, (childCounts.get(pid) ?? 0) + 1);
    }
  }
  return laneRows.map((raw) => {
    const id = String(raw.id);
    let branchRef = String(raw.branchRef ?? "refs/heads/main");
    if (!branchRef.startsWith("refs/")) {
      branchRef = `refs/heads/${branchRef.replace(/^refs\/heads\//, "")}`;
    }
    const st = raw.status;
    return {
      id,
      name: String(raw.name ?? "lane"),
      description: raw.description ?? null,
      laneType:
        raw.laneType === "primary" ||
        raw.laneType === "worktree" ||
        raw.laneType === "attached"
          ? raw.laneType
          : "worktree",
      baseRef: String(raw.baseRef ?? "main"),
      branchRef,
      worktreePath: String(raw.worktreePath ?? "/tmp/mock"),
      attachedRootPath: raw.attachedRootPath ?? null,
      parentLaneId: raw.parentLaneId ?? null,
      childCount: childCounts.get(id) ?? 0,
      stackDepth: 0,
      parentStatus: null,
      isEditProtected: Boolean(raw.isEditProtected),
      status: {
        dirty: Boolean(st?.dirty),
        ahead: st?.ahead ?? 0,
        behind: st?.behind ?? 0,
        remoteBehind: st?.remoteBehind ?? -1,
        rebaseInProgress: Boolean(st?.rebaseInProgress),
      },
      color: raw.color ?? null,
      icon: raw.icon ?? null,
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      folder: raw.folder ?? null,
      createdAt: raw.createdAt ?? now,
      archivedAt: raw.archivedAt ?? null,
    };
  });
}

/**
 * Stand-in lanes appended to the snapshot's real lanes so every Lanes sidebar
 * State group has a member: a lane whose PR merged (Done, and behind main on
 * purpose, since merged lanes usually are), an old lane with no PR (Stale) plus
 * a stacked child in the same group (indented), and a fresh child of the first
 * live-PR lane (Quiet, shown with a "↳ parent" hint because its parent sits in
 * another group). The Done lane's merged PR is added in `mockLiveLanePrs`.
 */
const MOCK_SIDEBAR_DONE_LANE_ID = "mock-sidebar-done";
function mockSidebarGroupLanes(realLanes: any[]): any[] {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const liveParent = realLanes.find(
    (lane: any) => lane.laneType !== "primary" && !String(lane.name ?? "").startsWith("t3code/"),
  );
  const primaryId = realLanes.find((lane: any) => lane.laneType === "primary")?.id ?? null;
  const withCommit = (lane: any, lastCommitAt: string, behind = 0) => ({
    ...lane,
    parentLaneId: lane.parentLaneId === "lane-main" ? primaryId : lane.parentLaneId,
    lastCommitAt,
    status: { ...lane.status, behind, lastCommitAt },
  });
  const lanes = [
    withCommit(
      makeLane(MOCK_SIDEBAR_DONE_LANE_ID, "Usage meter polish", "refs/heads/ade/usage-meter-polish", {
        createdAt: hoursAgo(4 * 24),
        color: "#34d399",
      }),
      hoursAgo(2 * 24),
      6,
    ),
    withCommit(
      makeLane("mock-sidebar-stale", "Onboarding copy spike", "refs/heads/ade/onboarding-copy-spike", {
        createdAt: hoursAgo(45 * 24),
        childCount: 1,
      }),
      hoursAgo(31 * 24),
    ),
    withCommit(
      makeLane("mock-sidebar-stale-child", "Onboarding empty states", "refs/heads/ade/onboarding-empty-states", {
        createdAt: hoursAgo(40 * 24),
        parentLaneId: "mock-sidebar-stale",
        stackDepth: 1,
      }),
      hoursAgo(33 * 24),
    ),
  ];
  if (liveParent) {
    liveParent.childCount = (liveParent.childCount ?? 0) + 1;
    lanes.push(
      withCommit(
        makeLane("mock-sidebar-child", "Timeline filters", "refs/heads/ade/timeline-filters", {
          createdAt: hoursAgo(20),
          parentLaneId: liveParent.id,
          baseRef: String(liveParent.branchRef ?? "main").replace(/^refs\/heads\//, ""),
          stackDepth: 1,
        }),
        hoursAgo(5),
      ),
    );
  }
  return lanes;
}

const MOCK_LANES: any[] = USE_ADE_DB_SNAPSHOT
  ? (() => {
      const real = buildMockLanesFromAdeSnapshot(
        Array.isArray(ADE_DB_SNAPSHOT?.lanes) ? ADE_DB_SNAPSHOT.lanes : [],
      );
      return [...real, ...mockSidebarGroupLanes(real)];
    })()
  : BUILTIN_MOCK_LANES;

const ADE_DB_PR_SNAPSHOTS: any[] =
  USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.prSnapshots)
    ? ADE_DB_SNAPSHOT.prSnapshots
    : [];
const ADE_DB_PR_SNAPSHOT_BY_ID = new Map<string, any>(
  ADE_DB_PR_SNAPSHOTS.map((snapshot) => [String(snapshot.prId), snapshot]),
);
/**
 * The snapshot has no git log, so lanes get a stand-in: real commit subjects
 * from the exported PR snapshots, dated back from the lane's newest commit.
 * The newest `ahead` rows play the lane's own commits and a few older rows play
 * base history. Messages carry Co-Authored-By trailers so agent attribution shows.
 */
const MOCK_COMMIT_POOL: any[] = (() => {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const snapshot of ADE_DB_PR_SNAPSHOTS) {
    for (const commit of snapshot?.commits ?? []) {
      if (!commit?.sha || seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      out.push(commit);
    }
  }
  return out;
})();
const MOCK_COMMIT_TRAILERS = [
  "Claude Opus 5.5 <noreply@anthropic.com>",
  "Codex <noreply@openai.com>",
  "Claude Opus 5.5 <noreply@anthropic.com>",
  "Cursor Agent <cursoragent@cursor.com>",
  null,
];
const MOCK_COMMIT_MESSAGES = new Map<string, string>();

function mockLaneRecentCommits(args: any = {}): any[] | null {
  const lane = MOCK_LANES.find((row) => row.id === args?.laneId);
  if (!lane || MOCK_COMMIT_POOL.length === 0) return null;
  const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.floor(args.limit)) : 30;
  const ahead = lane.laneType === "primary" ? limit : Math.max(0, lane.status?.ahead ?? 0);
  const count = Math.min(limit, ahead + 5);
  let seed = 0;
  for (const ch of String(lane.id)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const end = Date.parse(lane.lastCommitAt ?? "") || Date.now() - 20 * 60_000;
  const start = Date.parse(lane.createdAt ?? "") || end - 7 * 86_400_000;
  const step = Math.max(12 * 60_000, (end - start) / Math.max(1, Math.min(ahead, count)));
  const lanePrefix = String(lane.id).replace(/[^0-9a-f]/gi, "").padEnd(8, "0").slice(0, 8);
  return Array.from({ length: count }, (_, index) => {
    const source = MOCK_COMMIT_POOL[(seed + index) % MOCK_COMMIT_POOL.length];
    const sourceSha = String(source.sha);
    const sha = `${sourceSha.slice(0, 7)}${index.toString(16).padStart(4, "0")}${lanePrefix}${sourceSha.slice(19)}`;
    const subject = String(source.message ?? "").split("\n")[0] ?? "";
    const trailer = MOCK_COMMIT_TRAILERS[(seed + index) % MOCK_COMMIT_TRAILERS.length];
    MOCK_COMMIT_MESSAGES.set(sha, trailer ? `${subject}\n\nCo-Authored-By: ${trailer}` : subject);
    return {
      sha,
      shortSha: sha.slice(0, 7),
      parents: [],
      authorName: String(source.author?.name ?? "ADE"),
      authoredAt: new Date(end - index * step).toISOString(),
      subject,
      pushed: index > 0,
    };
  });
}

const ADE_DB_OPERATIONS: any[] =
  USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.operations)
    ? ADE_DB_SNAPSHOT.operations
    : [];
const ADE_DB_SESSIONS: any[] =
  USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_SNAPSHOT?.sessions)
    ? ADE_DB_SNAPSHOT.sessions
    : [];
/** Prefer exported DB rows when present; otherwise built-ins so Work is usable without a snapshot file. */
const MOCK_SESSIONS: any[] = [
  ...(ADE_DB_SESSIONS.length > 0 ? ADE_DB_SESSIONS : BUILTIN_MOCK_SESSIONS),
];
const ADE_DB_CHAT_TRANSCRIPTS: Record<
  string,
  { events?: any[]; path?: string | null }
> =
  USE_ADE_DB_SNAPSHOT &&
  ADE_DB_SNAPSHOT?.chatTranscripts &&
  typeof ADE_DB_SNAPSHOT.chatTranscripts === "object"
    ? ADE_DB_SNAPSHOT.chatTranscripts
    : {};
const ADE_DB_AUTOMATIONS =
  USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.automations
    ? ADE_DB_SNAPSHOT.automations
    : null;

function normalizeBrowserMockRelPath(rel: unknown): string {
  let s = String(rel ?? "")
    .trim()
    .replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "." || s === "/") return "";
  return s.replace(/\/+$/, "");
}

function languageIdForBrowserMockPath(relPath: string): string {
  const lower = relPath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs")
    return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".md") return "markdown";
  if (ext === ".py") return "python";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  if (ext === ".swift") return "swift";
  return "plaintext";
}

/** Depth-1 listTree rows keyed by parent path ("" = workspace root), from `export-browser-mock-ade-snapshot.mjs`. */
const ADE_DB_FILES_TREE_BY_WORKSPACE: Record<
  string,
  Record<string, any[]>
> = USE_ADE_DB_SNAPSHOT &&
ADE_DB_SNAPSHOT?.filesTreeByWorkspace &&
typeof ADE_DB_SNAPSHOT.filesTreeByWorkspace === "object"
  ? ADE_DB_SNAPSHOT.filesTreeByWorkspace
  : {};

const ADE_DB_FILES_CONTENTS_BY_WORKSPACE: Record<
  string,
  Record<string, any>
> = USE_ADE_DB_SNAPSHOT &&
ADE_DB_SNAPSHOT?.filesContentsByWorkspace &&
typeof ADE_DB_SNAPSHOT.filesContentsByWorkspace === "object"
  ? ADE_DB_SNAPSHOT.filesContentsByWorkspace
  : {};

function makeBuiltinSyntheticFilesTreeIndex(): Record<string, any[]> {
  return {
    "": [
      { name: "apps", path: "apps", type: "directory", changeStatus: null },
      { name: "docs", path: "docs", type: "directory", changeStatus: null },
      {
        name: "AGENTS.md",
        path: "AGENTS.md",
        type: "file",
        changeStatus: null,
      },
      {
        name: "package.json",
        path: "package.json",
        type: "file",
        changeStatus: null,
      },
    ],
    apps: [
      {
        name: "desktop",
        path: "apps/desktop",
        type: "directory",
        changeStatus: null,
      },
      {
        name: "ade-cli",
        path: "apps/ade-cli",
        type: "directory",
        changeStatus: null,
      },
    ],
    "apps/desktop": [
      {
        name: "package.json",
        path: "apps/desktop/package.json",
        type: "file",
        changeStatus: null,
      },
      {
        name: "src",
        path: "apps/desktop/src",
        type: "directory",
        changeStatus: null,
      },
    ],
    "apps/desktop/src": [
      {
        name: "renderer",
        path: "apps/desktop/src/renderer",
        type: "directory",
        changeStatus: null,
      },
    ],
    "apps/desktop/src/renderer": [
      {
        name: "browserMock.ts",
        path: "apps/desktop/src/renderer/browserMock.ts",
        type: "file",
        changeStatus: null,
      },
    ],
    docs: [
      {
        name: "README.md",
        path: "docs/README.md",
        type: "file",
        changeStatus: null,
      },
    ],
  };
}

const BUILTIN_FILES_TREE_BY_WORKSPACE: Record<
  string,
  Record<string, any[]>
> = Object.fromEntries(
  MOCK_LANES.map((lane) => [
    String(lane.id),
    makeBuiltinSyntheticFilesTreeIndex(),
  ]),
);

function getBrowserMockFilesWorkspaces(): any[] {
  return [...MOCK_LANES]
    .map((lane) => {
      const laneType =
        lane.laneType === "primary" ||
        lane.laneType === "attached" ||
        lane.laneType === "worktree"
          ? lane.laneType
          : "worktree";
      return {
        id: String(lane.id),
        kind: laneType,
        laneId: String(lane.id),
        name: String(lane.name ?? lane.id),
        branchRef:
          typeof lane.branchRef === "string" ? lane.branchRef : undefined,
        rootPath: String(lane.worktreePath ?? MOCK_PROJECT.rootPath),
        isReadOnlyByDefault: false,
        mobileReadOnly: true,
      };
    })
    .sort((a, b) => {
      if (a.kind === b.kind) return 0;
      if (a.kind === "primary") return -1;
      if (b.kind === "primary") return 1;
      return 0;
    });
}

function getBrowserMockListTreeNodes(
  workspaceId: string,
  parentPath: string,
): any[] {
  const parentKey = normalizeBrowserMockRelPath(parentPath);
  const snapTree = ADE_DB_FILES_TREE_BY_WORKSPACE[workspaceId];
  if (snapTree && Object.prototype.hasOwnProperty.call(snapTree, parentKey)) {
    const rows = snapTree[parentKey];
    return Array.isArray(rows) ? rows : [];
  }
  const builtin = BUILTIN_FILES_TREE_BY_WORKSPACE[workspaceId];
  if (builtin && Object.prototype.hasOwnProperty.call(builtin, parentKey)) {
    const rows = builtin[parentKey];
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

function getBrowserMockReadFilePayload(
  workspaceId: string,
  relPath: string,
): any {
  const normalized = normalizeBrowserMockRelPath(relPath);
  const fromSnapshot =
    ADE_DB_FILES_CONTENTS_BY_WORKSPACE[workspaceId]?.[normalized];
  if (fromSnapshot && typeof fromSnapshot.content === "string") {
    return {
      content: fromSnapshot.content,
      encoding: fromSnapshot.encoding ?? "utf-8",
      size: Number(fromSnapshot.size ?? fromSnapshot.content.length),
      languageId:
        fromSnapshot.languageId ?? languageIdForBrowserMockPath(normalized),
      isBinary: Boolean(fromSnapshot.isBinary),
    };
  }
  const stub = `// Browser mock (Vite preview)\n// Workspace ${workspaceId}\n// ${normalized || "(root)"}\n// Export with: npm run export:browser-mock-ade\n`;
  return {
    content: stub,
    encoding: "utf-8",
    size: new TextEncoder().encode(stub).length,
    languageId: languageIdForBrowserMockPath(normalized),
    isBinary: false,
  };
}

function isMockChatToolType(toolType: unknown): boolean {
  const normalized = String(toolType ?? "")
    .trim()
    .toLowerCase();
  return Boolean(
    normalized &&
    (normalized === "codex-chat" ||
      normalized === "claude-chat" ||
      normalized === "opencode-chat" ||
      normalized === "cursor" ||
      normalized === "droid" ||
      normalized === "droid-chat" ||
      normalized.endsWith("-chat")),
  );
}

function inferMockChatProvider(
  session: any,
): "claude" | "codex" | "cursor" | "droid" | "opencode" {
  const metadataProvider = String(session?.resumeMetadata?.provider ?? "")
    .trim()
    .toLowerCase();
  if (
    metadataProvider === "claude" ||
    metadataProvider === "codex" ||
    metadataProvider === "cursor" ||
    metadataProvider === "droid" ||
    metadataProvider === "opencode"
  ) {
    return metadataProvider;
  }
  const toolType = String(session?.toolType ?? "")
    .trim()
    .toLowerCase();
  if (toolType.startsWith("claude")) return "claude";
  if (toolType.startsWith("codex")) return "codex";
  if (toolType === "cursor" || toolType.startsWith("cursor")) return "cursor";
  if (toolType === "droid-chat" || toolType.startsWith("droid")) return "droid";
  return "opencode";
}

/**
 * The session the preview hangs its two question cards off.
 *
 * Pending input is derived from transcript events, never from a static field,
 * so the only way a browser preview can show a question card at all is to end
 * one transcript with the `approval_request` events a real provider would have
 * emitted. Two of them, because the blocking and non-blocking cards differ in
 * exactly the way that is worth being able to look at: only the non-blocking
 * one may be dismissed.
 */
const BROWSER_MOCK_QUESTION_SESSION_ID = "26abbf0f-20fb-4a97-a1e7-ce6b6dd6ee08";

function browserMockQuestionEvents(sessionId: string): any[] {
  if (sessionId !== BROWSER_MOCK_QUESTION_SESSION_ID) return [];
  const at = new Date(Date.now() - 60_000).toISOString();
  return [
    // The turn's own diff row. Scoped to the turn the transcript actually ends
    // on, so the preview shows the "N files changed" summary where a real one
    // would land rather than inventing a turn of its own.
    {
      sessionId,
      timestamp: at,
      sequence: 990_000,
      event: {
        type: "turn_diff_summary",
        turnId: "01a0ba94-3c3a-7ed1-8335-e3cf1b6da7a4",
        beforeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        afterSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        files: [
          { path: "apps/desktop/src/renderer/components/usage/UsageAccountRow.tsx", additions: 42, deletions: 9, status: "M" },
        ],
        totalAdditions: 42,
        totalDeletions: 9,
      },
    },
    {
      sessionId,
      timestamp: at,
      sequence: 990_001,
      event: {
        type: "approval_request",
        itemId: "mock-question-blocking",
        description: "Which migration should this lane take?",
        turnId: "mock-question-turn",
        detail: {
          request: {
            requestId: "mock-question-blocking",
            itemId: "mock-question-blocking",
            source: "codex",
            kind: "structured_question",
            title: "Migration strategy",
            description: "The old routes still have callers, so the answer changes the rollout.",
            blocking: true,
            allowsFreeform: true,
            canProceedWithoutAnswer: false,
            turnId: "mock-question-turn",
            questions: [
              {
                id: "strategy",
                header: "Rollout",
                question: "Which migration should this lane take?",
                allowsFreeform: true,
                options: [
                  { label: "Keep /api/v1 for one release", value: "keep", description: "Dual-serve, delete next release.", recommended: true },
                  { label: "Redirect /api/v1 to /api/v2", value: "redirect", description: "One hop, no dual maintenance." },
                  { label: "Break it now", value: "break", description: "Callers are all in this repo." },
                ],
              },
            ],
          },
        },
      },
    },
    {
      sessionId,
      timestamp: at,
      sequence: 990_002,
      event: {
        type: "approval_request",
        itemId: "mock-question-async",
        description: "Want a changelog entry for this too?",
        turnId: "mock-question-turn",
        detail: {
          request: {
            requestId: "mock-question-async",
            itemId: "mock-question-async",
            source: "codex",
            kind: "structured_question",
            title: "Changelog entry",
            description: "Answer whenever — this one does not hold the turn.",
            blocking: false,
            allowsFreeform: true,
            canProceedWithoutAnswer: true,
            // The flag the renderer reads for the dismiss affordance: only a
            // provider that says the answer is optional gets an ✕ that walks
            // away without answering.
            providerMetadata: { dismissible: true },
            turnId: "mock-question-turn",
            questions: [
              {
                id: "changelog",
                header: "Changelog",
                question: "Want a changelog entry for this too?",
                allowsFreeform: true,
                options: [
                  { label: "Yes, add one", value: "yes" },
                  { label: "No", value: "no" },
                ],
              },
            ],
          },
        },
      },
    },
  ];
}

function getMockChatTranscriptEvents(sessionId: string): any[] {
  const events = ADE_DB_CHAT_TRANSCRIPTS[sessionId]?.events;
  const base = Array.isArray(events)
    ? events.filter((entry) => entry?.sessionId === sessionId && entry?.event)
    : [];
  return [...base, ...browserMockQuestionEvents(sessionId)];
}

function latestMockDoneEvent(events: any[]): any | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "done") return event;
  }
  return null;
}

function fallbackMockModelForProvider(
  provider: "claude" | "codex" | "cursor" | "droid" | "opencode",
): string {
  if (provider === "claude") return "sonnet";
  if (provider === "codex") return DEFAULT_BROWSER_MOCK_CODEX_MODEL;
  if (provider === "cursor") return "auto";
  if (provider === "droid") return "claude-opus-4-6";
  return "opencode/mock";
}

function fallbackMockModelIdForProvider(
  provider: "claude" | "codex" | "cursor" | "droid" | "opencode",
): string {
  if (provider === "claude") return DEFAULT_BROWSER_MOCK_CLAUDE_MODEL;
  if (provider === "codex") return DEFAULT_BROWSER_MOCK_CODEX_MODEL;
  if (provider === "cursor") return "cursor/auto";
  if (provider === "droid") return "droid/claude-opus-4-6";
  return "opencode/mock";
}

function mockAgentChatSummaryFromSession(session: any): any | null {
  if (!session || !isMockChatToolType(session.toolType)) return null;
  const provider = inferMockChatProvider(session);
  const events = getMockChatTranscriptEvents(String(session.id));
  const done = latestMockDoneEvent(events);
  const modelId = String(
    session.resumeMetadata?.modelId ??
      session.resumeMetadata?.launch?.modelId ??
      done?.modelId ??
      fallbackMockModelIdForProvider(provider),
  );
  const model = String(
    session.resumeMetadata?.model ??
      session.resumeMetadata?.launch?.model ??
      done?.model ??
      fallbackMockModelForProvider(provider),
  );
  const endedAt = session.endedAt ?? null;
  const lastActivityAt =
    session.lastActivityAt ?? session.endedAt ?? session.startedAt ?? now;
  const status = session.status === "running" ? "idle" : "ended";
  return {
    sessionId: String(session.id),
    laneId: String(session.laneId ?? ""),
    provider,
    model,
    modelId,
    sessionProfile: session.resumeMetadata?.sessionProfile ?? "workflow",
    title: session.title ?? null,
    goal: session.goal ?? null,
    reasoningEffort: session.resumeMetadata?.reasoningEffort ?? null,
    fastMode: (session.resumeMetadata?.fastMode ?? session.resumeMetadata?.codexFastMode) === true,
    executionMode: session.resumeMetadata?.executionMode ?? null,
    permissionMode: session.resumeMetadata?.permissionMode ?? null,
    interactionMode: session.resumeMetadata?.interactionMode ?? null,
    claudePermissionMode:
      session.resumeMetadata?.claudePermissionMode ?? undefined,
    codexApprovalPolicy:
      session.resumeMetadata?.codexApprovalPolicy ?? undefined,
    codexSandbox: session.resumeMetadata?.codexSandbox ?? undefined,
    codexConfigSource: session.resumeMetadata?.codexConfigSource ?? undefined,
    opencodePermissionMode:
      session.resumeMetadata?.opencodePermissionMode ?? undefined,
    droidPermissionMode:
      session.resumeMetadata?.droidPermissionMode ?? undefined,
    cursorModeSnapshot: session.resumeMetadata?.cursorModeSnapshot ?? undefined,
    cursorModeId: session.resumeMetadata?.cursorModeId ?? null,
    cursorConfigValues: session.resumeMetadata?.cursorConfigValues ?? null,
    identityKey: session.resumeMetadata?.identityKey ?? undefined,
    surface: session.resumeMetadata?.surface ?? "work",
    automationId: session.resumeMetadata?.automationId ?? null,
    automationRunId: session.resumeMetadata?.automationRunId ?? null,
    capabilityMode: session.resumeMetadata?.capabilityMode ?? null,
    completion: session.resumeMetadata?.completion ?? null,
    status,
    idleSinceAt: status === "idle" ? lastActivityAt : null,
    startedAt: session.startedAt ?? now,
    endedAt,
    archivedAt: session.archivedAt ?? null,
    lastActivityAt,
    lastOutputPreview: session.lastOutputPreview ?? null,
    summary: session.summary ?? null,
    threadId: session.resumeMetadata?.threadId ?? undefined,
    requestedCwd: session.resumeMetadata?.requestedCwd ?? null,
    orchestrationParentSessionId: session.orchestrationParentSessionId ?? undefined,
    spawnKind: session.spawnKind ?? undefined,
  };
}

function listMockAgentChatSummaries(args: any = {}): any[] {
  let rows = MOCK_SESSIONS.map(mockAgentChatSummaryFromSession).filter(
    (session): session is any => Boolean(session),
  );
  if (typeof args?.laneId === "string" && args.laneId.trim()) {
    rows = rows.filter((session) => session.laneId === args.laneId.trim());
  }
  if (!args?.includeAutomation) {
    rows = rows.filter((session) => (session.surface ?? "work") === "work");
  }
  return rows;
}

/**
 * Returns a fresh snapshot object on every call to avoid shared-state leakage.
 * Annotated (rather than `any`) so the mock's wire shape is compiler-checked
 * against the real emitters — that is what catches a dropped `adoptableAttached`.
 */
function makeLaneSnapshot(lane: LaneSummary): LaneListSnapshot {
  const runtimeBucket =
    lane.id === "lane-auth" || lane.id === "lane-checkout"
      ? "running"
      : lane.id === "lane-dashboard" || lane.id === "lane-api"
        ? "awaiting-input"
        : lane.id === "lane-perf"
          ? "ended"
          : "none";
  return {
    lane: { ...lane },
      runtime: {
        bucket: runtimeBucket,
        runningCount: runtimeBucket === "running" ? 1 : 0,
        awaitingInputCount: runtimeBucket === "awaiting-input" ? 1 : 0,
        pendingInputCount: runtimeBucket === "awaiting-input" ? 1 : 0,
        endedCount: runtimeBucket === "ended" ? 1 : 0,
        sessionCount: runtimeBucket === "none" ? 0 : 1,
      },
    rebaseSuggestion:
      lane.id === "lane-dashboard" || lane.id === "lane-onboard"
        ? {
            laneId: lane.id,
            parentLaneId: "lane-main",
            parentHeadSha: "mock",
            behindCount: 2,
            lastSuggestedAt: now,
            deferredUntil: null,
            dismissedAt: null,
            hasPr: true,
          }
        : null,
    autoRebaseStatus:
      lane.id === "lane-perf"
        ? {
            laneId: lane.id,
            parentLaneId: "lane-main",
            parentHeadSha: "mock",
            state: "autoRebased",
            updatedAt: now,
            conflictCount: 0,
            message: "Mock auto-rebase",
          }
        : null,
    conflictStatus:
      lane.id === "lane-dashboard" || lane.id === "lane-search"
        ? {
            laneId: lane.id,
            status: "conflict-active",
            overlappingFileCount: 2,
            peerConflictCount: 2,
            lastPredictedAt: now,
          }
        : null,
    stateSnapshot: null,
    // Mirrors the real snapshot builders: always false, never computed. The
    // field is deliberately REQUIRED on `LaneListSnapshot` even though no
    // TypeScript surface reads it — shipped iOS builds decode it as a
    // non-optional Bool, so every emitter (this preview included) must keep
    // sending the key, and requiredness is what makes the compiler say so.
    adoptableAttached: false,
  };
}

// ── Helper for PrWithConflicts ────────────────────────────────
function makePr(
  id: string,
  laneId: string,
  num: number,
  title: string,
  opts: Partial<any> = {},
): any {
  return {
    id,
    laneId,
    projectId: "browser-mock",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: num,
    githubUrl: `https://github.com/acme/ade/pull/${num}`,
    githubNodeId: id.toUpperCase(),
    title,
    state: "open",
    baseBranch: "main",
    headBranch:
      MOCK_LANES.find((l: any) => l.id === laneId)?.branchRef?.replace(
        "refs/heads/",
        "",
      ) ?? laneId,
    checksStatus: "passing",
    reviewStatus: "none",
    additions: 100,
    deletions: 20,
    lastSyncedAt: now,
    createdAt: yesterday,
    updatedAt: now,
    conflictAnalysis: null,
    ...opts,
  };
}

// ── Normal PRs (5 varied states) ──────────────────────────────
const NORMAL_PRS: any[] = [
  makePr("pr-1", "lane-auth", 142, "Add OAuth2 login flow with PKCE", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 847,
    deletions: 123,
    createdAt: yesterday,
    conflictAnalysis: {
      prId: "pr-1",
      laneId: "lane-auth",
      riskLevel: "low",
      overlapCount: 0,
      conflictPredicted: false,
      peerConflicts: [],
      analyzedAt: now,
    },
  }),
  makePr(
    "pr-2",
    "lane-dashboard",
    145,
    "Dashboard v2 — metric cards & chart widgets",
    {
      state: "open",
      checksStatus: "failing",
      reviewStatus: "changes_requested",
      additions: 1562,
      deletions: 340,
      createdAt: twoDaysAgo,
      conflictAnalysis: {
        prId: "pr-2",
        laneId: "lane-dashboard",
        riskLevel: "medium",
        overlapCount: 3,
        conflictPredicted: true,
        peerConflicts: [
          {
            peerId: "pr-3",
            peerName: "Refactor REST endpoints",
            riskLevel: "medium",
            overlapFiles: ["src/lib/metrics.ts"],
          },
        ],
        analyzedAt: now,
      },
    },
  ),
  makePr(
    "pr-3",
    "lane-api",
    148,
    "Refactor REST endpoints to use Zod schemas",
    {
      state: "draft",
      checksStatus: "pending",
      reviewStatus: "requested",
      additions: 2100,
      deletions: 980,
      createdAt: yesterday,
      conflictAnalysis: null,
    },
  ),
  makePr("pr-4", "lane-perf", 151, "Fix N+1 query in session list endpoint", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 45,
    deletions: 12,
    createdAt: oneHourAgo,
    conflictAnalysis: {
      prId: "pr-4",
      laneId: "lane-perf",
      riskLevel: "low",
      overlapCount: 0,
      conflictPredicted: false,
      peerConflicts: [],
      analyzedAt: now,
    },
  }),
  makePr(
    "pr-5",
    "lane-onboard",
    153,
    "Onboarding wizard with step-by-step project setup",
    {
      // ADE-135 fixture: the only PR here whose CI never ran. Three
      // third-party apps reported success (see MOCK_CHECKS_BY_PR["pr-5"]) and
      // GitHub Actions registered nothing, which is exactly the shape that
      // used to render "CI passed · 3 jobs".
      state: "open",
      checksStatus: "not_run",
      checksReason:
        "3 checks reported, none from a CI provider. CI has not run on this commit.",
      checksMissingRequired: ["ci / build"],
      reviewStatus: "none",
      additions: 620,
      deletions: 80,
      createdAt: now,
      conflictAnalysis: {
        prId: "pr-5",
        laneId: "lane-onboard",
        riskLevel: "high",
        overlapCount: 5,
        conflictPredicted: true,
        peerConflicts: [],
        analyzedAt: now,
      },
    },
  ),
];

// ── Integration PRs (2 PRs) ──────────────────────────────────
//
// pr-i1: Merges search + analytics into main (multi-source)
// pr-i2: Merges i18n + a11y into main (multi-source)
const INTEGRATION_PRS: any[] = [
  makePr("pr-i1", "lane-search", 180, "Search & Analytics integration branch", {
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    headBranch: "integration/search-analytics",
    additions: 2400,
    deletions: 300,
    createdAt: twoDaysAgo,
    conflictAnalysis: {
      prId: "pr-i1",
      laneId: "lane-search",
      riskLevel: "medium",
      overlapCount: 2,
      conflictPredicted: false,
      peerConflicts: [
        {
          peerId: "pr-i2",
          peerName: "i18n + a11y integration",
          riskLevel: "low",
          overlapFiles: ["src/App.tsx"],
        },
      ],
      analyzedAt: now,
    },
  }),
  makePr(
    "pr-i2",
    "lane-i18n",
    185,
    "Internationalization & accessibility bundle",
    {
      state: "open",
      checksStatus: "failing",
      reviewStatus: "changes_requested",
      headBranch: "integration/i18n-a11y",
      additions: 1800,
      deletions: 420,
      createdAt: yesterday,
      conflictAnalysis: {
        prId: "pr-i2",
        laneId: "lane-i18n",
        riskLevel: "high",
        overlapCount: 7,
        conflictPredicted: true,
        peerConflicts: [
          {
            peerId: "pr-2",
            peerName: "Dashboard v2",
            riskLevel: "medium",
            overlapFiles: [
              "src/components/Dashboard.tsx",
              "src/styles/global.css",
            ],
          },
        ],
        analyzedAt: now,
      },
    },
  ),
];

/**
 * The exported snapshot only carries PRs of lanes that are long gone, so the
 * Lanes dashboard would never show a live PR. Three live lanes get stand-in
 * PRs built from their own name and branch: open with failing checks and
 * changes requested (plus one earlier merged PR), a draft with checks
 * running, and an open approved PR with passing checks.
 */
function mockLiveLanePrs(): any[] {
  const lanes = MOCK_LANES.filter(
    (lane: any) => lane.laneType !== "primary" && !String(lane.name ?? "").startsWith("t3code/"),
  ).slice(0, 3);
  const looks = [
    { state: "open", checksStatus: "failing", reviewStatus: "changes_requested", mergeConflicts: true, additions: 412, deletions: 96 },
    { state: "draft", checksStatus: "pending", reviewStatus: "none", mergeConflicts: false, additions: 58, deletions: 12 },
    { state: "open", checksStatus: "passing", reviewStatus: "approved", mergeConflicts: false, additions: 1204, deletions: 377 },
  ];
  const out: any[] = [];
  // The sidebar's Done stand-in lane (see `mockSidebarGroupLanes`) merged.
  const doneLane = MOCK_LANES.find((lane: any) => lane.id === MOCK_SIDEBAR_DONE_LANE_ID);
  if (doneLane) {
    out.push({
      laneId: doneLane.id,
      projectId: MOCK_PROJECT.id ?? "mock-project",
      repoOwner: "arul28",
      repoName: "ADE",
      githubNodeId: null,
      baseBranch: "main",
      lastSyncedAt: now,
      id: "mock-sidebar-pr-1227",
      githubPrNumber: 1227,
      githubUrl: "https://github.com/arul28/ADE/pull/1227",
      title: String(doneLane.name),
      headBranch: String(doneLane.branchRef).replace(/^refs\/heads\//, ""),
      state: "merged",
      checksStatus: "passing",
      reviewStatus: "approved",
      mergeConflicts: false,
      additions: 184,
      deletions: 52,
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      mergedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
  }
  lanes.forEach((lane: any, index: number) => {
    const look = looks[index]!;
    const branch = String(lane.branchRef ?? "").replace(/^refs\/heads\//, "");
    const number = 1301 + index;
    const base = {
      laneId: lane.id,
      projectId: MOCK_PROJECT.id ?? "mock-project",
      repoOwner: "arul28",
      repoName: "ADE",
      githubNodeId: null,
      baseBranch: "main",
      lastSyncedAt: now,
    };
    out.push({
      ...base,
      id: `mock-live-pr-${number}`,
      githubPrNumber: number,
      githubUrl: `https://github.com/arul28/ADE/pull/${number}`,
      title: String(lane.name ?? branch),
      headBranch: branch,
      ...look,
      createdAt: new Date(Date.now() - (index + 1) * 26 * 3_600_000).toISOString(),
      updatedAt: new Date(Date.now() - (index + 1) * 40 * 60_000).toISOString(),
      mergedAt: null,
    });
    if (index === 0) {
      out.push({
        ...base,
        id: `mock-live-pr-${number}-earlier`,
        githubPrNumber: 1240,
        githubUrl: "https://github.com/arul28/ADE/pull/1240",
        title: `${String(lane.name ?? branch)}: first pass`,
        headBranch: `${branch}-v1`,
        state: "merged",
        checksStatus: "passing",
        reviewStatus: "approved",
        mergeConflicts: false,
        additions: 230,
        deletions: 41,
        createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        updatedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        mergedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      });
    }
  });
  return out;
}

// ── All PRs combined ──────────────────────────────────────────
const ALL_PRS = USE_ADE_DB_SNAPSHOT
  ? [...(Array.isArray(ADE_DB_SNAPSHOT?.prs) ? ADE_DB_SNAPSHOT.prs : []), ...mockLiveLanePrs()]
  : [...NORMAL_PRS, ...INTEGRATION_PRS];

function getAdeDbPrSnapshotByGithubCoordinates(args: any): any | null {
  const repoOwner = String(args?.repoOwner ?? "").trim().toLowerCase();
  const repoName = String(args?.repoName ?? "").trim().toLowerCase();
  const githubPrNumber = Number(args?.githubPrNumber);
  if (!repoOwner || !repoName || !Number.isInteger(githubPrNumber) || githubPrNumber <= 0) return null;

  const pr = ALL_PRS.find((candidate: any) =>
    String(candidate.repoOwner ?? "").trim().toLowerCase() === repoOwner
    && String(candidate.repoName ?? "").trim().toLowerCase() === repoName
    && Number(candidate.githubPrNumber) === githubPrNumber,
  );
  return pr ? ADE_DB_PR_SNAPSHOT_BY_ID.get(String(pr.id)) ?? null : null;
}

// ── Merge Contexts ────────────────────────────────────────────
const BUILTIN_MOCK_MERGE_CONTEXTS: Record<string, any> = {
  // Normal PRs — no group
  "pr-1": {
    prId: "pr-1",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-auth"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-2": {
    prId: "pr-2",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-dashboard"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-3": {
    prId: "pr-3",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-api"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-4": {
    prId: "pr-4",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-perf"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },
  "pr-5": {
    prId: "pr-5",
    groupId: null,
    groupType: null,
    sourceLaneIds: ["lane-onboard"],
    targetLaneId: "lane-main",
    integrationLaneId: null,
    members: [],
  },

  // Integration PRs — multi-source
  "pr-i1": {
    prId: "pr-i1",
    groupId: "integration-search-analytics",
    groupType: "integration",
    sourceLaneIds: ["lane-search", "lane-analytics"],
    targetLaneId: "lane-main",
    integrationLaneId: "lane-search",
    members: [
      {
        prId: "pr-i1",
        laneId: "lane-search",
        laneName: "integration/search-analytics",
        prNumber: 180,
        position: 0,
        role: "integration",
      },
      {
        prId: "pr-i1",
        laneId: "lane-search",
        laneName: "feature/search-v2",
        prNumber: 180,
        position: 0,
        role: "source",
      },
      {
        prId: "pr-i1",
        laneId: "lane-analytics",
        laneName: "feature/analytics",
        prNumber: null,
        position: 1,
        role: "source",
      },
    ],
  },
  "pr-i2": {
    prId: "pr-i2",
    groupId: "integration-i18n-a11y",
    groupType: "integration",
    sourceLaneIds: ["lane-i18n", "lane-a11y"],
    targetLaneId: "lane-main",
    integrationLaneId: "lane-i18n",
    members: [
      {
        prId: "pr-i2",
        laneId: "lane-i18n",
        laneName: "integration/i18n-a11y",
        prNumber: 185,
        position: 0,
        role: "integration",
      },
      {
        prId: "pr-i2",
        laneId: "lane-i18n",
        laneName: "feature/i18n",
        prNumber: 185,
        position: 0,
        role: "source",
      },
      {
        prId: "pr-i2",
        laneId: "lane-a11y",
        laneName: "feature/accessibility",
        prNumber: null,
        position: 1,
        role: "source",
      },
    ],
  },
};

const MOCK_MERGE_CONTEXTS: Record<string, any> = USE_ADE_DB_SNAPSHOT
  ? (ADE_DB_SNAPSHOT?.prMergeContexts ?? {})
  : BUILTIN_MOCK_MERGE_CONTEXTS;

// ── Per-PR detail data (keyed by prId) ────────────────────────
const MOCK_CHECKS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    {
      name: "CI / Build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Lint",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Unit Tests",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / E2E Tests",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "Deploy Preview",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
  ],
  "pr-2": [
    {
      name: "CI / Build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Lint",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / Unit Tests",
      status: "completed",
      conclusion: "failure",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
    {
      name: "CI / E2E Tests",
      status: "completed",
      conclusion: "skipped",
      detailsUrl: "#",
      startedAt: yesterday,
      completedAt: now,
    },
  ],
  "pr-3": [
    {
      name: "CI / Build",
      status: "in_progress",
      conclusion: null,
      detailsUrl: "#",
      startedAt: now,
      completedAt: null,
    },
    {
      name: "CI / Lint",
      status: "queued",
      conclusion: null,
      detailsUrl: "#",
      startedAt: null,
      completedAt: null,
    },
    {
      name: "CI / Unit Tests",
      status: "queued",
      conclusion: null,
      detailsUrl: "#",
      startedAt: null,
      completedAt: null,
    },
  ],
  "pr-4": [
    {
      name: "CI / Build",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: oneHourAgo,
      completedAt: now,
    },
    {
      name: "CI / Unit Tests",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: oneHourAgo,
      completedAt: now,
    },
  ],
  // Three green rows, zero CI: a review bot, a preview deploy, and a comment
  // bot. The rollup calls this "not_run" — the rows are real, the pass is not.
  "pr-5": [
    // Slugs are load-bearing: an ABSENT `appSlug` is treated as CI-eligible
    // (legacy rows carry none), so without them a producer-aware consumer like
    // `groupCheckItems` would file all three under CI and the fixture would
    // stop demonstrating the bug it exists to demonstrate.
    {
      name: "CodeRabbit",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: now,
      completedAt: now,
      appSlug: "coderabbitai",
    },
    {
      name: "Vercel — Preview",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: now,
      completedAt: now,
      appSlug: "vercel",
    },
    {
      name: "changeset-bot",
      status: "completed",
      conclusion: "success",
      detailsUrl: "#",
      startedAt: now,
      completedAt: now,
      appSlug: "changeset-bot",
    },
  ],
};

const MOCK_REVIEWS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    {
      reviewer: "alice",
      state: "approved",
      body: "LGTM! Clean implementation.",
      submittedAt: now,
    },
    {
      reviewer: "carol",
      state: "commented",
      body: "Nice work overall. Left a few minor suggestions.",
      submittedAt: yesterday,
    },
  ],
  "pr-2": [
    {
      reviewer: "bob",
      state: "changes_requested",
      body: "Please add error handling for the token refresh edge case.",
      submittedAt: now,
    },
    {
      reviewer: "dave",
      state: "changes_requested",
      body: "Dashboard layout breaks on mobile viewports.",
      submittedAt: yesterday,
    },
  ],
  "pr-3": [
    { reviewer: "alice", state: "pending", body: null, submittedAt: null },
  ],
  "pr-4": [
    {
      reviewer: "eve",
      state: "approved",
      body: "Quick fix, looks good.",
      submittedAt: now,
    },
  ],
  "pr-5": [],
};

const MOCK_COMMENTS_BY_PR: Record<string, any[]> = {
  "pr-1": [
    {
      id: "c1",
      author: "alice",
      body: "Have you considered using the `useAuth` hook from our shared lib?",
      source: "review",
      url: null,
      path: "src/hooks/useLogin.ts",
      line: 42,
      createdAt: yesterday,
      updatedAt: null,
    },
    {
      id: "c2",
      author: "ci-bot",
      body: "Coverage report: 94.2% (+1.3%)",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: now,
      updatedAt: null,
    },
  ],
  "pr-2": [
    {
      id: "c3",
      author: "bob",
      body: "The `metricReducer` doesn't handle negative values.",
      source: "review",
      url: null,
      path: "src/lib/metrics.ts",
      line: 87,
      createdAt: twoDaysAgo,
      updatedAt: null,
    },
    {
      id: "c4",
      author: "dave",
      body: "CSS grid is breaking at <768px — need a media query.",
      source: "review",
      url: null,
      path: "src/styles/dashboard.css",
      line: 15,
      createdAt: yesterday,
      updatedAt: null,
    },
    {
      id: "c5",
      author: "ci-bot",
      body: "Coverage report: 78.1% (-3.4%)",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: now,
      updatedAt: null,
    },
  ],
  "pr-3": [
    {
      id: "c6",
      author: "alice",
      body: "Should we keep backwards-compat for the old `/api/v1` routes?",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: yesterday,
      updatedAt: null,
    },
  ],
  "pr-4": [
    {
      id: "c7",
      author: "ci-bot",
      body: "Performance benchmark: p95 latency down from 420ms to 12ms",
      source: "issue",
      url: null,
      path: null,
      line: null,
      createdAt: now,
      updatedAt: null,
    },
  ],
  "pr-5": [],
};

const MOCK_STATUS_BY_PR: Record<string, any> = {
  "pr-1": {
    prId: "pr-1",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
  },
  "pr-2": {
    prId: "pr-2",
    state: "open",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    isMergeable: false,
    mergeConflicts: true,
    behindBaseBy: 12,
  },
  "pr-3": {
    prId: "pr-3",
    state: "draft",
    checksStatus: "pending",
    reviewStatus: "requested",
    isMergeable: false,
    mergeConflicts: false,
    behindBaseBy: 7,
  },
  "pr-4": {
    prId: "pr-4",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
  },
  "pr-5": {
    prId: "pr-5",
    state: "open",
    checksStatus: "not_run",
    checksReason:
      "3 checks reported, none from a CI provider. CI has not run on this commit.",
    checksMissingRequired: ["ci / build"],
    reviewStatus: "none",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 3,
  },
};

/**
 * Checks, reviews, merge status and changed files for the stand-in live lane
 * PRs (see `mockLiveLanePrs`), so the Lanes overview's pull request section
 * has something real to show: #1301 failing with conflicts, #1302 a draft
 * with checks still running, #1303 approved and green.
 */
const MOCK_LIVE_PR_FILES: Record<string, any[]> = {};
(function seedMockLivePrDetail() {
  const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const check = (name: string, state: "passed" | "failed" | "running" | "queued" | "skipped", minutes = 4) => ({
    name,
    status: state === "running" ? "in_progress" : state === "queued" ? "queued" : "completed",
    conclusion: state === "passed" ? "success" : state === "failed" ? "failure" : state === "skipped" ? "skipped" : null,
    detailsUrl: null,
    startedAt: state === "queued" ? null : iso(60),
    completedAt: state === "passed" || state === "failed" || state === "skipped" ? iso(60 - minutes) : null,
  });
  const files = (paths: Array<[string, string, number, number]>) =>
    paths.map(([filename, status, additions, deletions]) => ({ filename, status, additions, deletions, patch: null, previousFilename: null }));
  const livePrs = ALL_PRS.filter((pr: any) => String(pr.id ?? "").startsWith("mock-live-pr-") && !String(pr.id).endsWith("-earlier"));
  const looks: Array<{ checks: any[]; reviews: any[]; status: Record<string, unknown>; files: any[] }> = [
    {
      checks: [
        check("ci / typecheck", "passed", 3),
        check("ci / unit (desktop)", "failed", 7),
        check("ci / unit (ios)", "passed", 11),
        check("ci / lint", "passed", 2),
        check("ci / build (macos)", "running"),
      ],
      reviews: [
        { reviewer: "coderabbitai", reviewerAvatarUrl: null, reviewerIsBot: true, state: "commented", body: null, submittedAt: iso(300) },
        { reviewer: "arul28", reviewerAvatarUrl: null, state: "changes_requested", body: null, submittedAt: iso(200) },
      ],
      status: { mergeConflicts: true, isMergeable: false, behindBaseBy: 12 },
      files: files([
        ["apps/desktop/src/renderer/components/lanes/LanesPage.tsx", "modified", 212, 88],
        ["apps/desktop/src/renderer/components/lanes/overview/LaneTimeline.tsx", "added", 164, 0],
        ["apps/desktop/src/renderer/components/lanes/overview/laneTimelineModel.ts", "added", 96, 0],
        ["apps/desktop/src/main/services/lanes/laneEventService.ts", "modified", 44, 8],
        ["apps/desktop/src/renderer/components/lanes/LaneStackPane.tsx", "removed", 0, 131],
        ["docs/features/lanes/README.md", "modified", 12, 4],
      ]),
    },
    {
      checks: [
        check("ci / typecheck", "passed", 3),
        check("ci / lint", "passed", 2),
        check("ci / unit (desktop)", "running"),
        check("ci / build (macos)", "queued"),
        check("ci / build (windows)", "queued"),
      ],
      reviews: [],
      status: { mergeConflicts: false, isMergeable: true, behindBaseBy: 0 },
      files: files([
        ["apps/desktop/src/main/services/macDesktop/virtualDisplay.ts", "added", 41, 0],
        ["apps/desktop/src/main/services/macDesktop/displayRegistry.ts", "modified", 12, 9],
        ["apps/ios/ADE/Views/MacDesktop/MacDesktopView.swift", "modified", 5, 3],
      ]),
    },
    {
      checks: [
        "ci / typecheck", "ci / lint", "ci / unit (desktop)", "ci / unit (ios)", "ci / unit (cli)",
        "ci / build (macos)", "ci / build (windows)", "ci / e2e", "CodeRabbit",
      ].map((name, index) => check(name, "passed", 2 + index)),
      reviews: [
        { reviewer: "arul28", reviewerAvatarUrl: null, state: "approved", body: null, submittedAt: iso(50) },
      ],
      status: { mergeConflicts: false, isMergeable: true, behindBaseBy: 0 },
      files: files([
        ["apps/desktop/src/main/services/macDesktop/macDesktopSeat.ts", "modified", 388, 120],
        ["apps/desktop/src/main/services/macDesktop/h264Decoder.ts", "renamed", 210, 77],
        ["apps/desktop/src/renderer/components/macDesktop/MacDesktopPane.tsx", "modified", 301, 94],
        ["apps/desktop/src/renderer/components/macDesktop/useMacDesktopStream.ts", "added", 142, 0],
        ["apps/desktop/src/shared/types/macDesktop.ts", "modified", 36, 11],
        ["apps/ade-cli/src/commands/macDesktop.ts", "modified", 58, 21],
        ["apps/desktop/src/main/services/macDesktop/legacyCapture.ts", "removed", 0, 54],
        ["docs/features/mac-desktop/README.md", "modified", 29, 0],
      ]),
    },
  ];
  livePrs.forEach((pr: any, index: number) => {
    const look = looks[index];
    if (!look) return;
    MOCK_CHECKS_BY_PR[pr.id] = look.checks;
    MOCK_REVIEWS_BY_PR[pr.id] = look.reviews;
    MOCK_STATUS_BY_PR[pr.id] = {
      prId: pr.id,
      state: pr.state,
      checksStatus: pr.checksStatus,
      reviewStatus: pr.reviewStatus,
      ...look.status,
    };
    MOCK_LIVE_PR_FILES[pr.id] = look.files;
  });
})();

// ── Rebase Needs (all urgency categories) ─────────────────────
const BUILTIN_MOCK_REBASE_NEEDS: any[] = [
  // Attention: behind + conflicts predicted
  {
    laneId: "lane-dashboard",
    laneName: "feature/dashboard-v2",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 12,
    conflictPredicted: true,
    conflictingFiles: [
      "src/components/Dashboard.tsx",
      "src/lib/metrics.ts",
      "src/styles/dashboard.css",
    ],
    prId: "pr-2",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  {
    laneId: "lane-i18n",
    laneName: "feature/i18n",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 8,
    conflictPredicted: true,
    conflictingFiles: ["src/i18n/translations.json", "src/App.tsx"],
    prId: "pr-i2",
    groupContext: "integration-i18n-a11y",
    dismissedAt: null,
    deferredUntil: null,
  },
  // Clean rebase: behind but no conflicts
  {
    laneId: "lane-api",
    laneName: "feature/api-refactor",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 7,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-3",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  {
    laneId: "lane-onboard",
    laneName: "feature/onboarding-wizard",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 3,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-5",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  // Up to date (behind 0)
  {
    laneId: "lane-auth",
    laneName: "feature/auth-flow",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 0,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-1",
    groupContext: null,
    dismissedAt: null,
    deferredUntil: null,
  },
  // Deferred (still behind but snoozed — categorized as upToDate)
  {
    laneId: "lane-search",
    laneName: "feature/search-v2",
    kind: "lane_base",
    baseBranch: "main",
    behindBy: 5,
    conflictPredicted: false,
    conflictingFiles: [],
    prId: "pr-i1",
    groupContext: "integration-search-analytics",
    dismissedAt: null,
    deferredUntil: fourHoursFromNow,
  },
];

const MOCK_REBASE_NEEDS: any[] = USE_ADE_DB_SNAPSHOT
  ? Array.isArray(ADE_DB_SNAPSHOT?.rebaseNeeds)
    ? ADE_DB_SNAPSHOT.rebaseNeeds
    : []
  : BUILTIN_MOCK_REBASE_NEEDS;

// ── Integration simulation result ─────────────────────────────
const BUILTIN_MOCK_INTEGRATION_SIMULATION: any = {
  proposalId: "sim-mock-1",
  sourceLaneIds: ["lane-search", "lane-analytics"],
  baseBranch: "main",
  overallOutcome: "conflict",
  steps: [
    {
      laneId: "lane-search",
      laneName: "feature/search-v2",
      position: 0,
      outcome: "clean",
      conflictingFiles: [],
      diffStat: { insertions: 1420, deletions: 180, filesChanged: 22 },
    },
    {
      laneId: "lane-analytics",
      laneName: "feature/analytics",
      position: 1,
      outcome: "conflict",
      conflictingFiles: [
        { path: "src/lib/analytics.ts", conflictMarkers: "<<<<<<< HEAD..." },
        { path: "src/App.tsx", conflictMarkers: "<<<<<<< HEAD..." },
      ],
      diffStat: { insertions: 980, deletions: 120, filesChanged: 14 },
    },
  ],
  createdAt: now,
};

const MOCK_INTEGRATION_SIMULATION: any = USE_ADE_DB_SNAPSHOT
  ? {
      proposalId: "empty",
      sourceLaneIds: [] as string[],
      baseBranch: "main",
      overallOutcome: "clean",
      steps: [] as any[],
      createdAt: now,
    }
  : BUILTIN_MOCK_INTEGRATION_SIMULATION;

const BUILTIN_MOCK_INTEGRATION_WORKFLOWS: any[] = [
  {
    proposalId: "workflow-int-active",
    sourceLaneIds: ["lane-search", "lane-analytics"],
    baseBranch: "main",
    pairwiseResults: [],
    laneSummaries: [
      {
        laneId: "lane-search",
        laneName: "feature/search-v2",
        outcome: "clean",
        commitHash: "abc1234",
        commitCount: 4,
        conflictsWith: [],
        diffStat: { insertions: 1420, deletions: 180, filesChanged: 22 },
      },
      {
        laneId: "lane-analytics",
        laneName: "feature/analytics",
        outcome: "clean",
        commitHash: "def5678",
        commitCount: 3,
        conflictsWith: [],
        diffStat: { insertions: 980, deletions: 120, filesChanged: 14 },
      },
    ],
    steps: BUILTIN_MOCK_INTEGRATION_SIMULATION.steps,
    overallOutcome: "clean",
    createdAt: twoDaysAgo,
    title: "Search & Analytics integration branch",
    body: "This integration workflow bundles search and analytics for a shared release train.",
    draft: false,
    integrationLaneName: "integration/search-analytics",
    status: "committed",
    integrationLaneId: "lane-search",
    linkedGroupId: "integration-search-analytics",
    linkedPrId: "pr-i1",
    workflowDisplayState: "active",
    cleanupState: "none",
    closedAt: null,
    mergedAt: null,
    completedAt: null,
    cleanupDeclinedAt: null,
    cleanupCompletedAt: null,
    resolutionState: null,
  },
  {
    proposalId: "workflow-int-history",
    sourceLaneIds: ["lane-i18n", "lane-a11y"],
    baseBranch: "main",
    pairwiseResults: [],
    laneSummaries: [
      {
        laneId: "lane-i18n",
        laneName: "feature/i18n",
        outcome: "conflict",
        commitHash: "ghi9012",
        commitCount: 6,
        conflictsWith: ["lane-a11y"],
        diffStat: { insertions: 1100, deletions: 220, filesChanged: 19 },
      },
      {
        laneId: "lane-a11y",
        laneName: "feature/accessibility",
        outcome: "conflict",
        commitHash: "jkl3456",
        commitCount: 2,
        conflictsWith: ["lane-i18n"],
        diffStat: { insertions: 700, deletions: 90, filesChanged: 9 },
      },
    ],
    steps: [
      {
        laneId: "lane-i18n",
        laneName: "feature/i18n",
        position: 0,
        outcome: "conflict",
        conflictingFiles: [
          {
            path: "src/App.tsx",
            conflictMarkers: "<<<<<<< HEAD...",
            oursExcerpt: null,
            theirsExcerpt: null,
            diffHunk: null,
          },
        ],
        diffStat: { insertions: 1100, deletions: 220, filesChanged: 19 },
      },
      {
        laneId: "lane-a11y",
        laneName: "feature/accessibility",
        position: 1,
        outcome: "conflict",
        conflictingFiles: [
          {
            path: "src/App.tsx",
            conflictMarkers: "<<<<<<< HEAD...",
            oursExcerpt: null,
            theirsExcerpt: null,
            diffHunk: null,
          },
        ],
        diffStat: { insertions: 700, deletions: 90, filesChanged: 9 },
      },
    ],
    overallOutcome: "conflict",
    createdAt: threeDaysAgo,
    title: "Internationalization & accessibility bundle",
    body: "Closed after validation. Cleanup was declined so the workflow lives in history.",
    draft: false,
    integrationLaneName: "integration/i18n-a11y",
    status: "committed",
    integrationLaneId: "lane-i18n",
    linkedGroupId: "integration-i18n-a11y",
    linkedPrId: "pr-i2",
    workflowDisplayState: "history",
    cleanupState: "declined",
    closedAt: yesterday,
    mergedAt: null,
    completedAt: yesterday,
    cleanupDeclinedAt: yesterday,
    cleanupCompletedAt: null,
    resolutionState: null,
  },
];

const MOCK_INTEGRATION_WORKFLOWS: any[] = USE_ADE_DB_SNAPSHOT
  ? Array.isArray(ADE_DB_SNAPSHOT?.integrationWorkflows)
    ? ADE_DB_SNAPSHOT.integrationWorkflows
    : []
  : BUILTIN_MOCK_INTEGRATION_WORKFLOWS;

function isBotGitHubAuthor(author: unknown): boolean {
  if (typeof author !== "string" || !author.trim()) return false;
  const normalized = author.toLowerCase();
  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("-bot") ||
    normalized.includes("dependabot")
  );
}

function normalizeGitHubPrListItem(item: any): any {
  return {
    ...item,
    labels: Array.isArray(item?.labels) ? item.labels : [],
    isBot: typeof item?.isBot === "boolean" ? item.isBot : isBotGitHubAuthor(item?.author),
    commentCount:
      typeof item?.commentCount === "number"
        ? item.commentCount
        : Number(item?.commentCount ?? 0),
    // Merged-view fields. DB-derived snapshots (ADE_DB_SNAPSHOT) predate these, so
    // default them here rather than letting the merged row render `undefined`.
    detached: item?.detached ?? null,
    mergedAt: item?.mergedAt ?? null,
    mergedBy: item?.mergedBy ?? null,
    mergeMethod: item?.mergeMethod ?? null,
    additions: item?.additions ?? null,
    deletions: item?.deletions ?? null,
    commitCount: item?.commitCount ?? null,
    changedFiles: item?.changedFiles ?? null,
  };
}

function normalizeGitHubSnapshot(snapshot: any): any {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  return {
    ...snapshot,
    stacks: Array.isArray(snapshot.stacks) ? snapshot.stacks : [],
    repoPullRequests: Array.isArray(snapshot.repoPullRequests)
      ? snapshot.repoPullRequests.map(normalizeGitHubPrListItem)
      : [],
    externalPullRequests: Array.isArray(snapshot.externalPullRequests)
      ? snapshot.externalPullRequests.map(normalizeGitHubPrListItem)
      : [],
  };
}

function buildCreateLaneFromPrPreflight(args: any): any {
  const repoOwner = String(args?.repoOwner ?? "mock");
  const repoName = String(args?.repoName ?? "repo");
  const githubPrNumber = Number(args?.githubPrNumber ?? 0);
  const headBranch = args?.headBranch ?? null;
  const title = String(args?.title ?? `PR #${githubPrNumber}`);
  const targetLaneName =
    typeof headBranch === "string" && headBranch.trim()
      ? headBranch.replace(/^[^/]+\//, "")
      : `pr-${githubPrNumber}`;
  return {
    repoOwner,
    repoName,
    githubPrNumber,
    githubUrl: String(
      args?.githubUrl ??
        `https://github.com/${repoOwner}/${repoName}/pull/${githubPrNumber}`,
    ),
    title,
    headBranch,
    headSha: null,
    headRepoOwner: repoOwner,
    headRepoName: repoName,
    remoteBranch: headBranch,
    importBranchRef: headBranch,
    targetLaneName,
    baseBranch: args?.baseBranch ?? "main",
    canCreate: true,
    status: "ready",
    blockingConflict: null,
    blockingConflicts: [],
  };
}

const BUILTIN_MOCK_GITHUB_SNAPSHOT: any = {
  repo: { owner: "acme", name: "ade" },
  viewerLogin: "mock-user",
  syncedAt: now,
  repoPullRequests: [
    ...ALL_PRS.map((pr: any) => {
      const ctx = MOCK_MERGE_CONTEXTS[pr.id] ?? null;
      const workflow =
        MOCK_INTEGRATION_WORKFLOWS.find((item) => item.linkedPrId === pr.id) ??
        null;
      return {
        id: pr.id,
        scope: "repo",
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        githubPrNumber: pr.githubPrNumber,
        githubUrl: pr.githubUrl,
        title: pr.title,
        state: pr.state === "draft" ? "draft" : pr.state,
        isDraft: pr.state === "draft",
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        author: "mock-user",
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        linkedPrId: pr.id,
        linkedGroupId: workflow?.linkedGroupId ?? ctx?.groupId ?? null,
        linkedLaneId: pr.laneId,
        linkedLaneName:
          MOCK_LANES.find((lane: any) => lane.id === pr.laneId)?.name ??
          pr.laneId,
        adeKind: workflow ? "integration" : (ctx?.groupType ?? "single"),
        workflowDisplayState: workflow?.workflowDisplayState ?? null,
        cleanupState: workflow?.cleanupState ?? null,
      };
    }),
    {
      id: "repo-unmapped-191",
      scope: "repo",
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 191,
      githubUrl: "https://github.com/acme/ade/pull/191",
      title: "Hotfix from GitHub UI with no ADE lane",
      state: "open",
      isDraft: false,
      baseBranch: "main",
      headBranch: "hotfix/github-ui-edit",
      author: "teammate",
      createdAt: oneHourAgo,
      updatedAt: now,
      linkedPrId: null,
      linkedGroupId: null,
      linkedLaneId: null,
      linkedLaneName: null,
      adeKind: null,
      workflowDisplayState: null,
      cleanupState: null,
    },
    // Merged history, spread across period boundaries so the day/week group headers
    // and their aggregates have something real to render.
    {
      id: "repo-merged-detached-188",
      scope: "repo",
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 188,
      githubUrl: "https://github.com/acme/ade/pull/188",
      title: "Automatic lane naming",
      state: "merged",
      isDraft: false,
      baseBranch: "main",
      headBranch: "ade/auto-lane-naming",
      author: "arul",
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      updatedAt: oneHourAgo,
      mergedAt: oneHourAgo,
      mergedBy: { login: "arul", avatarUrl: null },
      mergeMethod: "squash",
      additions: 412,
      deletions: 88,
      commitCount: 12,
      changedFiles: 9,
      // The lane was deleted after merge — the case that used to render as `unmapped`.
      detached: {
        at: oneHourAgo,
        laneName: "auto-lane-naming",
        laneColor: "#4ADE80",
        chats: 3,
        artifacts: 2,
        checkpoints: 7,
      },
      linkedPrId: null,
      linkedGroupId: null,
      linkedLaneId: null,
      linkedLaneName: null,
      adeKind: null,
      workflowDisplayState: null,
      cleanupState: null,
    },
    {
      id: "repo-merged-cleanup-187",
      scope: "repo",
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 187,
      githubUrl: "https://github.com/acme/ade/pull/187",
      title: "Web client machine selection",
      state: "merged",
      isDraft: false,
      baseBranch: "main",
      headBranch: "ade/web-machine-selection",
      author: "arul",
      createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      mergedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      mergedBy: { login: "arul", avatarUrl: null },
      mergeMethod: "merge",
      additions: 96,
      deletions: 14,
      commitCount: 4,
      changedFiles: 3,
      linkedPrId: null,
      linkedGroupId: null,
      linkedLaneId: null,
      linkedLaneName: null,
      adeKind: null,
      workflowDisplayState: null,
      // The one honest amber left in the merged list: the remote branch still exists.
      cleanupState: "required",
    },
    {
      id: "repo-closed-unmapped-186",
      scope: "repo",
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 186,
      githubUrl: "https://github.com/acme/ade/pull/186",
      title: "Abandoned spike",
      state: "closed",
      isDraft: false,
      baseBranch: "main",
      headBranch: "spike/abandoned",
      author: "teammate",
      createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 38 * 86_400_000).toISOString(),
      linkedPrId: null,
      linkedGroupId: null,
      linkedLaneId: null,
      linkedLaneName: null,
      adeKind: null,
      workflowDisplayState: null,
      cleanupState: null,
    },
  ],
  externalPullRequests: [
    {
      id: "external-42",
      scope: "external",
      repoOwner: "acme",
      repoName: "infra",
      githubPrNumber: 42,
      githubUrl: "https://github.com/acme/infra/pull/42",
      title: "Rotate runner credentials for deployment fleet",
      state: "open",
      isDraft: false,
      baseBranch: "main",
      headBranch: "ops/runner-credential-rotation",
      author: "mock-user",
      createdAt: yesterday,
      updatedAt: now,
      linkedPrId: null,
      linkedGroupId: null,
      linkedLaneId: null,
      linkedLaneName: null,
      adeKind: null,
      workflowDisplayState: null,
      cleanupState: null,
    },
  ],
};

const MOCK_GITHUB_SNAPSHOT: any = normalizeGitHubSnapshot(
  USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.githubSnapshot
    ? ADE_DB_SNAPSHOT.githubSnapshot
    : BUILTIN_MOCK_GITHUB_SNAPSHOT,
);

function browserMockPrSummaryWithStack(pr: any): any {
  const pull = MOCK_GITHUB_SNAPSHOT.repoPullRequests.find(
    (item: any) =>
      item.repoOwner === pr.repoOwner
      && item.repoName === pr.repoName
      && item.githubPrNumber === pr.githubPrNumber,
  );
  return {
    ...pr,
    stack: pull?.stack ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Wire it up
// ═══════════════════════════════════════════════════════════════

/**
 * In Electron, preload already set `window.ade` and must win. In the Vite dev browser
 * we set `__adeBrowserMock` so we can re-run this file on HMR (Vite re-executes the module,
 * but `window.ade` already exists from the first load — a naive `!window.ade` guard would skip
 * the mock and leave a stale, broken stub). Only skip the mock when the real Electron preload
 * is present: a partial `window.ade` from another script would otherwise keep a broken object
 * (missing `sync`, `onboarding`, …).
 */
function shouldInstallBrowserMock(target: Window): boolean {
  const w = target as any;
  return !(
    w.ade &&
    !w.__adeBrowserMock &&
    typeof w.ade.sync?.getStatus === "function"
  );
}

if (typeof window !== "undefined" && shouldInstallBrowserMock(window)) {
  const w = window as any;
  if (w.ade) {
    console.warn(
      "[ADE] Re-applying full window.ade browser mock (e.g. Vite HMR).",
    );
  } else {
    console.warn(
      "[ADE] Running outside Electron — injecting browser mock for window.ade",
    );
  }
  w.__adeBrowserMock = true;
  let mockZoomLevel = 0;
  const vitestRuntime = typeof process !== "undefined" && Boolean(process.env.VITEST);
  if (!vitestRuntime) {
    applyHostedWebZoom(zoomFactorForDisplay(getStoredZoomLevel()));
  }
  const BROWSER_MOCK_LOCAL_DEVICE: any = {
    deviceId: "browser-mock-device",
    siteId: "browser-mock-site",
    name: "Browser preview",
    platform: "macOS",
    deviceType: "desktop",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastHost: null,
    lastPort: null,
    tailscaleIp: null,
    ipAddresses: ["127.0.0.1"],
    metadata: {},
  };

  const BROWSER_MOCK_SYNC_SNAPSHOT: any = {
    mode: "standalone",
    role: "brain",
    localDevice: BROWSER_MOCK_LOCAL_DEVICE,
    currentBrain: BROWSER_MOCK_LOCAL_DEVICE,
    clusterState: null,
    bootstrapToken: null,
    pairingPin: null,
    pairingPinConfigured: false,
    runtimeName: null,
    pairingConnectInfo: null,
    connectedPeers: [],
    tailnetDiscovery: {
      state: "disabled",
      serviceName: "ade-sync",
      servicePort: 0,
      target: null,
      updatedAt: null,
      error: null,
      stderr: null,
    },
    client: {
      state: "disconnected",
      host: null,
      port: null,
      connectedAt: null,
      lastSeenAt: null,
      latencyMs: null,
      syncLag: null,
      lastRemoteDbVersion: 0,
      brainDeviceId: BROWSER_MOCK_LOCAL_DEVICE.deviceId,
      hostName: "Browser preview",
      error: null,
      message: null,
      savedDraft: null,
    },
    transferReadiness: {
      ready: true,
      blockers: [],
      survivableState: [],
    },
    survivableStateText: "Idle (browser preview)",
    blockingStateText: "",
  };

  const BROWSER_MOCK_PROVIDER_CONNECTION = (
    provider: "claude" | "codex" | "cursor" | "droid",
  ) => ({
    provider,
    // Detected-but-not-authed, which is what makes the demo quota fixture below
    // visible without also claiming the preview can *run* these providers:
    // `hasUsableProviderConnection` still reads false, so nothing auth-gated
    // changes, while `hasLocalProviderConnectionSignal` (the Limits surface's
    // question) reads true.
    authAvailable: false,
    runtimeDetected: provider === "claude" || provider === "codex",
    runtimeAvailable: false,
    usageAvailable: provider === "claude" || provider === "codex",
    path: null,
    blocker: null,
    lastCheckedAt: now,
    sources: [] as { kind: string }[],
  });

  const BROWSER_MOCK_AI_STATUS: any = {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: {
          present: true,
          source: "path",
          path: "/opt/homebrew/bin/claude",
        },
        auth: {
          ready: false,
          mode: "none",
          detail: null,
        },
      },
      codex: false,
      cursor: false,
      droid: false,
    },
    models: { claude: [], codex: [], cursor: [], droid: [] },
    availableModelIds: [
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5-codex",
    ],
    features: [
      { feature: "pr_descriptions", enabled: true },
      { feature: "terminal_summaries", enabled: false },
      { feature: "commit_messages", enabled: false },
    ],
    providerConnections: {
      claude: BROWSER_MOCK_PROVIDER_CONNECTION("claude"),
      codex: BROWSER_MOCK_PROVIDER_CONNECTION("codex"),
      cursor: BROWSER_MOCK_PROVIDER_CONNECTION("cursor"),
      droid: BROWSER_MOCK_PROVIDER_CONNECTION("droid"),
    },
  };

  // A demo quota fixture, so the Limits surface in the browser preview renders
  // the shape it renders in the app: two providers, several windows, and more
  // than one account pooled across machines.
  const BROWSER_MOCK_NOW_MS = Date.now();
  const browserMockResetAt = (ms: number) => new Date(BROWSER_MOCK_NOW_MS + ms).toISOString();
  // The threshold list, read top to bottom. It was a four-deep nested ternary,
  // which hid which band a delta of exactly -4 lands in.
  const browserMockPacingStatus = (delta: number): string => {
    if (delta > 12) return "far-ahead";
    if (delta > 4) return "ahead";
    if (delta < -12) return "far-behind";
    if (delta < -4) return "behind";
    return "on-track";
  };
  const browserMockPacing = (used: number, elapsed: number, resetsInHours: number) => ({
    status: browserMockPacingStatus(used - elapsed),
    projectedWeeklyPercent: Math.min(100, elapsed > 0 ? (used / elapsed) * 100 : used),
    weekElapsedPercent: elapsed,
    expectedPercent: elapsed,
    deltaPercent: used - elapsed,
    etaHours: used > 0 ? Math.max(1, ((100 - used) / used) * resetsInHours) : null,
    willLastToReset: used <= elapsed,
    resetsInHours,
  });
  const BROWSER_MOCK_USAGE_SNAPSHOT: any = {
    accounts: [
      {
        id: "claude:ada.lovelace@example.com",
        instanceId: "claude",
        label: "Default",
        provider: "claude",
        email: "ada.lovelace@example.com",
        plan: "Claude Max 20x",
        machines: [
          { machineKey: "studio", label: "studio-mbp", checkedAt: now },
          { machineKey: "nucbox", label: "nucbox-1", checkedAt: now },
        ],
        url: usageProviderAccountUrl("claude"),
      },
      {
        id: "claude:jo.martin@example.com",
        instanceId: "claude-work",
        label: "Work",
        provider: "claude",
        email: "jo.martin@example.com",
        plan: "Claude Pro",
        machines: [{ machineKey: "nucbox", label: "nucbox-1", checkedAt: now }],
        url: usageProviderAccountUrl("claude"),
      },
      {
        id: "codex:dev@example.com",
        instanceId: "codex",
        label: "Default",
        provider: "codex",
        // One spendable reset credit: the preview needs the state that makes
        // the "Use reset" button appear at all.
        resetCredits: {
          availableCount: 1,
          nextExpiresAt: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
        },
        email: "dev@example.com",
        plan: "ChatGPT Pro 20x Subscription",
        machines: [{ machineKey: "studio", label: "studio-mbp", checkedAt: now }],
        url: usageProviderAccountUrl("codex"),
      },
    ],
    windows: [
      {
        provider: "codex",
        windowType: "weekly",
        accountId: "codex:dev@example.com",
        percentUsed: 51,
        resetsAt: browserMockResetAt(6 * 86_400_000 + 7 * 3_600_000),
        resetsInMs: 6 * 86_400_000 + 7 * 3_600_000,
        pacing: browserMockPacing(51, 42, 151),
      },
      {
        provider: "claude",
        windowType: "five_hour",
        accountId: "claude:ada.lovelace@example.com",
        percentUsed: 12,
        resetsAt: browserMockResetAt(4 * 3_600_000 + 5 * 60_000),
        resetsInMs: 4 * 3_600_000 + 5 * 60_000,
        pacing: browserMockPacing(12, 18, 4),
      },
      {
        provider: "claude",
        windowType: "five_hour",
        accountId: "claude:jo.martin@example.com",
        percentUsed: 3,
        resetsAt: browserMockResetAt(58 * 60_000),
        resetsInMs: 58 * 60_000,
        pacing: browserMockPacing(3, 80, 1),
      },
      {
        provider: "claude",
        windowType: "weekly",
        accountId: "claude:ada.lovelace@example.com",
        percentUsed: 55,
        resetsAt: browserMockResetAt(2 * 86_400_000 + 11 * 3_600_000),
        resetsInMs: 2 * 86_400_000 + 11 * 3_600_000,
        modelBreakdown: { Opus: 62, Sonnet: 31, Haiku: 7 },
        pacing: browserMockPacing(55, 64, 59),
      },
      {
        provider: "claude",
        windowType: "weekly",
        accountId: "claude:jo.martin@example.com",
        percentUsed: 27,
        resetsAt: browserMockResetAt(6 * 86_400_000 + 6 * 3_600_000),
        resetsInMs: 6 * 86_400_000 + 6 * 3_600_000,
        pacing: browserMockPacing(27, 14, 150),
      },
      {
        provider: "claude",
        windowType: "weekly_oauth_apps",
        accountId: "claude:ada.lovelace@example.com",
        percentUsed: 93,
        resetsAt: browserMockResetAt(2 * 86_400_000 + 11 * 3_600_000),
        resetsInMs: 2 * 86_400_000 + 11 * 3_600_000,
        pacing: browserMockPacing(93, 64, 59),
      },
      {
        provider: "claude",
        windowType: "weekly_oauth_apps",
        accountId: "claude:jo.martin@example.com",
        percentUsed: 71,
        resetsAt: browserMockResetAt(6 * 86_400_000 + 6 * 3_600_000),
        resetsInMs: 6 * 86_400_000 + 6 * 3_600_000,
        pacing: browserMockPacing(71, 14, 150),
      },
    ],
    pacing: browserMockPacing(48, 42, 151),
    providerStatus: {
      claude: {
        state: "ok",
        lastSuccessAt: now,
        source: "oauth",
        updatedAt: now,
        accountEmail: "ada.lovelace@example.com",
        accountPlan: "Claude Max 20x",
        accountUrl: usageProviderAccountUrl("claude"),
      },
      codex: {
        state: "ok",
        lastSuccessAt: now,
        source: "cli",
        updatedAt: now,
        accountEmail: "dev@example.com",
        accountPlan: "ChatGPT Pro 20x Subscription",
        accountUrl: usageProviderAccountUrl("codex"),
      },
    },
    dailyUsage7d: {
      claude: [820_000, 1_240_000, 640_000, 1_910_000, 1_460_000, 380_000, 1_120_000],
      codex: [210_000, 460_000, 320_000, 180_000, 540_000, 90_000, 300_000],
    },
    costs: [],
    adeCosts: [],
    extraUsage: [],
    lastPolledAt: now,
    errors: [],
  };
  // The seeded snapshot wins only when it actually carries quota windows. A
  // seeded machine that has never polled a provider stores an empty snapshot,
  // and preferring it left the Limits surface stuck on skeleton rows with no
  // way to see the real layout in the preview.
  const BROWSER_USAGE_SNAPSHOT: any =
    USE_ADE_DB_SNAPSHOT && ADE_DB_SNAPSHOT?.usageSnapshot?.windows?.length
      ? ADE_DB_SNAPSHOT.usageSnapshot
      : BROWSER_MOCK_USAGE_SNAPSHOT;

  const browserStatsRangeForPreset = (preset: AdeUsageRangePreset) => {
    const until = new Date();
    const start = new Date(until);
    start.setHours(0, 0, 0, 0);
    if (preset === "7d") start.setDate(start.getDate() - 6);
    if (preset === "30d") start.setDate(start.getDate() - 29);
    if (preset === "year") start.setDate(start.getDate() - 364);
    return {
      preset,
      since: preset === "all" ? null : start.toISOString(),
      until: until.toISOString(),
    };
  };
  const makeBrowserStatsDailySkeleton = (range: { preset: AdeUsageRangePreset; since: string | null; until: string }) => {
    const maxDays = range.preset === "today" ? 1 : range.preset === "7d" ? 7 : range.preset === "30d" ? 30 : 365;
    const untilMs = Date.parse(range.until);
    const start = new Date(range.since ?? untilMs - (maxDays - 1) * 86_400_000);
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: maxDays }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        commits: 0,
        prs: 0,
        insertions: 0,
        deletions: 0,
        filesChanged: 0,
        sessions: 0,
      };
    });
  };
  const makeBrowserEmptyAdeUsageStats = (preset: AdeUsageRangePreset): any => {
    const range = browserStatsRangeForPreset(preset);
    return {
    generatedAt: now,
    range,
    summary: {
      totalTokens: 0,
      tokenTotalSource: "provider_logs",
      observedProviderTokens: 0,
      observedProviderInputTokens: 0,
      observedProviderOutputTokens: 0,
      observedProviderCachedTokens: 0,
      observedProviderCostRangeUsd: 0,
      observedProviderCost30dUsd: 0,
      observedProviderCostTodayUsd: 0,
      adeRuntimeTokens: 0,
      adeRuntimeInputTokens: 0,
      adeRuntimeOutputTokens: 0,
      adeRuntimeCachedTokens: 0,
      adeRuntimeCostRangeUsd: 0,
      adeRuntimeCost30dUsd: 0,
      adeRuntimeCostTodayUsd: 0,
      adeTotalTokens: 0,
      adeTotalCostRangeUsd: 0,
      trackedAdeTokens: 0,
      trackedAdeInputTokens: 0,
      trackedAdeOutputTokens: 0,
      trackedAdeCalls: 0,
      trackedAdeDurationMs: 0,
      workerTokens: 0,
      workerCostUsd: 0,
      chatSessions: 0,
      terminalSessions: 0,
      activeLanes: 0,
      lanesCreated: 0,
      lanesArchived: 0,
      lanesDeleted: 0,
      commitsCreated: 0,
      pushOperations: 0,
      prLandings: 0,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      artifactsCaptured: 0,
      automationRuns: 0,
      workerRuns: 0,
    },
    providers: [],
    models: [],
    adeProviders: [],
    adeModels: [],
    agentProviders: [],
    agentModels: [],
    features: [],
    lanes: [],
    activities: [],
    daily: makeBrowserStatsDailySkeleton(range),
    github: {
      repo: "Browser preview",
      available: true,
      lastFetchedAt: null,
      error: null,
    },
    sourceNotes: [],
  };
  };
  const BROWSER_ADE_USAGE_STATS_BY_PRESET: Record<string, any> =
    USE_STATS_DASHBOARD_SNAPSHOT &&
    ADE_DB_SNAPSHOT?.adeUsageStatsByPreset &&
    typeof ADE_DB_SNAPSHOT.adeUsageStatsByPreset === "object"
      ? ADE_DB_SNAPSHOT.adeUsageStatsByPreset
      : {};
  const getBrowserAdeUsageStats = async (args?: { preset?: string }) => {
    const preset = isAdeUsageRangePreset(args?.preset) ? args.preset : "7d";
    return BROWSER_ADE_USAGE_STATS_BY_PRESET[preset] ?? makeBrowserEmptyAdeUsageStats(preset);
  };

  const BROWSER_MOCK_BUDGET_CONFIG: any = {
    refreshIntervalMin: 15,
    budgetCaps: [] as any[],
    preset: "conservative",
  };

  /** Full enough for Settings and lane behavior in the dev browser. */
  const BROWSER_MOCK_PROJECT_CONFIG_SNAPSHOT: any = {
    shared: {
      version: 1,
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
    },
    local: {
      version: 1,
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      git: { autoRebaseOnHeadChange: false },
      laneCleanup: {},
      ai: {
        permissions: {
          cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
          inProcess: { mode: "full-auto" },
          providers: {
            claude: "full-auto",
            codex: "default",
            opencode: "full-auto",
            codexSandbox: "workspace-write",
          },
        },
      },
    },
    effective: {
      version: 1,
      testSuites: [],
      automations: [],
      laneOverlayPolicies: [],
      git: { autoRebaseOnHeadChange: false },
      ai: {
        featureModelOverrides: { pr_descriptions: "anthropic/claude-sonnet-5" },
        permissions: {
          cli: { mode: "full-auto", sandboxPermissions: "workspace-write" },
          inProcess: { mode: "full-auto" },
          providers: {
            claude: "full-auto",
            codex: "default",
            opencode: "full-auto",
            codexSandbox: "workspace-write",
          },
        },
      },
    },
    validation: { ok: true, issues: [] },
    trust: {
      sharedHash: "mock",
      localHash: "mock",
    },
    paths: {
      sharedPath: "/tmp/.ade/ade.yaml",
      localPath: "/tmp/.ade/local.yaml",
    },
  };

  const BROWSER_MOCK_DEVTOOLS_CHECK: any = {
    tools: [
      {
        id: "git" as const,
        label: "Git",
        command: "git",
        installed: true,
        detectedPath: "/usr/bin/git",
        detectedVersion: "2.0.0",
        required: true,
      },
    ],
    platform: "darwin",
  };

  const browserMockPersonalChats: any[] = [];
  const browserMockPromptStashes: PromptStashEntry[] = [];
  const browserMockPersonalChatEvents = new Map<string, any[]>();
  let browserMockPersonalChatSequence = 0;

  const appendBrowserMockPersonalChatEvent = (
    sessionId: string,
    event: Record<string, unknown>,
  ) => {
    const envelope = {
      sessionId,
      timestamp: new Date().toISOString(),
      event,
    };
    const events = browserMockPersonalChatEvents.get(sessionId) ?? [];
    events.push(envelope);
    browserMockPersonalChatEvents.set(sessionId, events);
    return envelope;
  };

  (window as any).ade = {
    analytics: {
      capture: async () => ({ accepted: false, reason: "not_configured" }),
      getStatus: async () => ({
        configured: false,
        enabled: true,
        effective: false,
        host: "https://us.i.posthog.com",
        dailyBudget: 200,
        acceptedToday: 0,
        droppedToday: 0,
        day: new Date().toISOString().slice(0, 10),
      }),
      setEnabled: async (enabled: boolean) => ({
        configured: false,
        enabled,
        effective: false,
        host: "https://us.i.posthog.com",
        dailyBudget: 200,
        acceptedToday: 0,
        droppedToday: 0,
        day: new Date().toISOString().slice(0, 10),
      }),
    },
    // Machine-owned ADE account (Clerk identity). The dev browser preview toggles
    // signed-in vs signed-out via localStorage `ade.mock.account` = "out".
    account: (() => {
      const signedOut = () => {
        try {
          return window.localStorage.getItem("ade.mock.account") === "out";
        } catch {
          return false;
        }
      };
      const setSignedOut = (value: boolean) => {
        try {
          if (value) {
            window.localStorage.setItem("ade.mock.account", "out");
          } else {
            window.localStorage.removeItem("ade.mock.account");
          }
        } catch {
          // localStorage may be unavailable in hardened contexts.
        }
      };
      const signedInStatus = {
        signedIn: true,
        userId: "user_2xMockAccount",
        email: "arul@ade.dev",
        name: "Arul Sharma",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        provider: "github" as const,
        imageUrl: null,
        configured: true,
      };
      const signedOutStatus = {
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
        provider: null,
        imageUrl: null,
        configured: true,
      };
      const status = () => (signedOut() ? signedOutStatus : signedInStatus);
      return {
        status: async () => status(),
        startLogin: async () => ({
          sessionId: "mock-session",
          authorizeUrl: "https://accounts.ade.dev/oauth/authorize?mock=1",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        pollLogin: async () => {
          setSignedOut(false);
          return {
            status: "signed_in" as const,
            message: null,
            authStatus: signedInStatus,
          };
        },
        cancelLogin: async () => status(),
        // Device sign-in runs inside a real ADE brain; the mock has none, so it
        // reports the same refusal the hosted web adapter does.
        startDeviceLogin: async () => {
          throw new Error("Open ADE on the computer you want to reconnect, then try again there.");
        },
        pollDeviceLogin: async () => ({
          status: "error" as const,
          message: "Open ADE on the computer you want to reconnect, then try again there.",
          intervalSec: null,
          authStatus: status(),
        }),
        cancelDeviceLogin: async () => status(),
        signOut: async () => {
          setSignedOut(true);
          return signedOutStatus;
        },
        // This computer, so the account page has a row it can expand into live
        // detail (the local row is the only one a preview can actually serve).
        getLocalMachineIdentity: async () => ({
          machineKey: "mk_studio",
          deviceId: "dev_studio",
          name: "Studio",
        }),
        getMachineInventory: async (machineKey?: string) => ({
          machineKey: machineKey ?? "mk_studio",
          providers: [
            {
              provider: "claude",
              modelCount: 6,
              accounts: [
                { instanceId: "claude", label: "Default", email: "ada.lovelace@example.com", plan: "Claude Max 20x", isDefault: true },
                { instanceId: "claude-work", label: "Work", email: "jo.martin@example.com", plan: "Claude Pro", isDefault: false },
              ],
            },
            {
              provider: "codex",
              modelCount: 4,
              accounts: [
                { instanceId: "codex", label: "Default", email: "dev@example.com", plan: "ChatGPT Pro 20x Subscription", isDefault: true },
              ],
            },
          ],
          // One preset bound to something this machine has, one that is not:
          // the unbound row is the state the "not set up here" note exists for.
          presets: [
            { id: "hp_1", name: "Opus on work account", harness: "claude", model: "claude-opus-4-1", bound: true },
            { id: "hp_9", name: "Droid on a key this Mac lacks", harness: "droid", model: "claude-sonnet-4-5", bound: false },
          ],
        }),
        listMachines: async () => {
          if (signedOut()) {
            return { state: "signed_out" as const, machines: [], message: null };
          }
          return {
            state: "ok" as const,
            message: null,
            machines: [
              {
                inventory: {
                  providers: [
                    { provider: "claude", accounts: 2, models: 6 },
                    { provider: "codex", accounts: 1, models: 4 },
                  ],
                  presets: 2,
                },
                machineKey: "mk_studio",
                deviceId: "dev_studio",
                name: "Studio",
                platform: "darwin",
                deviceType: "desktop",
                reachableEndpoints: [
                  { kind: "tailnet" as const, host: "100.92.14.3", port: 22 },
                ],
                lastSeenAt: Date.now() - 45_000,
                online: true,
              },
              {
                machineKey: "mk_mini",
                deviceId: "dev_mini",
                name: "Mac mini",
                platform: "darwin",
                deviceType: "desktop",
                reachableEndpoints: [
                  { kind: "relay" as const, url: "wss://relay.ade.dev/mini" },
                ],
                lastSeenAt: Date.now() - 6 * 3_600_000,
                online: false,
              },
            ],
          };
        },
        renameMachine: async (machineKey: string, customName: string | null) => ({
          machineKey,
          deviceId: `device-${machineKey}`,
          name: customName?.trim() || "Studio",
          customName: customName?.trim() || null,
          platform: "darwin",
          deviceType: "desktop",
          reachableEndpoints: [],
          lastSeenAt: Date.now(),
          online: true,
        }),
        pairMachine: async (machineKey: string) => ({
          targetId: `paired-${machineKey}`,
          machineKey,
          deviceId: "dev_studio",
          name: "Studio",
        }),
        onPairMachineProgress: () => () => {},
      };
    })(),
    // The account settings store, backed by an in-memory map so the preview
    // exercises the real hydrate/write-through path without a brain. Rows are
    // per-reload: the mock is a stand-in for another machine, not a cache.
    accountSettings: (() => {
      const rows = new Map<string, AccountSettingRow>();
      const rowKey = (scope: string, key: string) => `${scope}\u0000${key}`;
      return {
        list: async (args?: { scope?: string | null }) => ({
          ok: true as const,
          value: [...rows.values()].filter((row) => !args?.scope || row.scope === args.scope),
        }),
        get: async (args: { scope: string; key: string }) => ({
          ok: true as const,
          value: rows.get(rowKey(args.scope, args.key))?.value,
        }),
        set: async (args: { scope: string; key: string; value: unknown }) => {
          const at = new Date().toISOString();
          rows.set(rowKey(args.scope, args.key), {
            scope: args.scope,
            key: args.key,
            value: args.value,
            updatedAt: at,
            changedAt: at,
            writerDeviceId: "browser-mock",
          });
          return { ok: true as const, value: null };
        },
        sync: async () => ({ ok: true as const, value: null }),
      };
    })(),
    app: {
      // Mirrors the preload's synchronous channel bridge.
      packageChannel: browserMockPackageChannel(),
      // Mirrors the preload's synchronous platform bridge, so platform-gated UI
      // (the Windows beta notice) can be previewed with ?adePlatform=win32.
      runtimeTarget: { platform: browserMockPlatform(), arch: "x64" },
      ping: resolved("pong" as const),
      getInfo: resolved({
        appVersion: "0.0.0-browser",
        packageChannel: browserMockPackageChannel(),
        isPackaged: false,
        automationsEnabled: true,
        // Matches the synchronous runtimeTarget bridge above so platform-gated
        // surfaces (Settings → About's Windows beta row) preview correctly.
        platform: browserMockPlatform(),
        arch: "web",
        versions: {
          electron: "0.0.0-browser",
          chrome: "0.0.0-browser",
          node: "0.0.0-browser",
          v8: "0.0.0-browser",
        },
        env: {},
        localRuntime: {
          connectionState: "idle",
          pid: null,
          syncPort: null,
          publishHealth: null,
          lastWedge: null,
          runtimeMode: "primary",
          versionSkew: {
            state: "none",
            appVersion: "0.0.0-browser",
            runtimeVersion: "0.0.0-browser",
            message: null,
            updatedAt: null,
          },
          serviceInstall: {
            state: "skipped",
            attempted: false,
            path: null,
            message:
              "Background service installation is not available in the browser mock.",
            exitCode: null,
            updatedAt: null,
          },
          serviceHealth: {
            state: "unsupported",
            installed: null,
            running: null,
            path: null,
            message:
              "Background service status is not available in the browser mock.",
            checkedAt: null,
          },
        },
      }),
      onRuntimeStatusChanged: () => () => {},
      getResourceUsage: resolved({
        sampledAt: now,
        processCount: 1,
        cpuPercent: 0,
        mainCpuPercent: 0,
        rendererCpuPercent: 0,
        memoryMB: 0,
        mainMemoryMB: 0,
        rendererMemoryMB: 0,
        activePtyCount: 0,
        ptyProcessCount: 0,
        ptyCpuPercent: 0,
        ptyMemoryMB: 0,
        freeMemoryMB: 8_000,
        totalMemoryMB: 16_000,
        roleUsage: [
          { role: "ade-runtime", processCount: 1, cpuPercent: 2, memoryMB: 280 },
        ],
      }),
      getRuntimeHealth: resolved({
        slowActions24h: 0,
        slowActionP95Ms: null,
        sampledAt: now,
      }),
      getLatestRelease: resolved({
        version: "1.0.0",
        htmlUrl: "https://github.com/arul28/ADE/releases/latest",
        publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        updateAvailable: false,
      }),
      getProject: resolved(MOCK_PROJECT),
      getWindowSession: resolved({
        windowId: 1,
        project: MOCK_PROJECT,
        binding: {
          kind: "local",
          key: `local:${MOCK_PROJECT.rootPath}`,
          rootPath: MOCK_PROJECT.rootPath,
          displayName: MOCK_PROJECT.name,
        },
        openProjectTabs: [MOCK_PROJECT],
      }),
      getWelcomeVideoState: async () => readBrowserMockWelcomeVideoState(),
      markWelcomeVideoSeen: async (reason: "completed" | "dismissed" = "dismissed") => {
        const current = readBrowserMockWelcomeVideoState();
        const next = {
          ...current,
          completedAt: reason === "completed" ? new Date().toISOString() : current.completedAt,
          dismissedAt: reason === "completed" ? current.dismissedAt : new Date().toISOString(),
        };
        writeBrowserMockWelcomeVideoState(next);
        return next;
      },
      getLaunchGateState: resolved({ resolved: true }),
      resolveLaunchGate: resolved({ resolved: true as const }),
      setWindowProjectTabs: resolved({ openProjectTabs: [MOCK_PROJECT] }),
      newWindow: resolved({ windowId: 2 }),
      openProjectInNewWindow: resolvedArg({
        windowId: 2,
        project: MOCK_PROJECT,
      }),
      closeWindow: resolvedArg({ closed: false }),
      onProjectChanged: () => () => {},
      onProjectBindingChanged: () => () => {},
      onNavigate: () => () => {},
      openExternal: resolvedArg(undefined),
      revealPath: resolvedArg(undefined),
      writeClipboardText: async (text: string): Promise<void> => {
        const writeText = window.navigator.clipboard?.writeText;
        if (typeof writeText !== "function") return;
        await writeText.call(window.navigator.clipboard, text);
      },
      hasClipboardImage: resolved(false),
      readClipboardImage: resolved(null),
      saveClipboardImageAttachment: resolved(null),
      getImageDataUrl: resolvedArg({ dataUrl: BROWSER_MOCK_IMAGE_DATA_URL }),
      writeClipboardImage: resolvedArg(undefined),
      openPath: resolvedArg(undefined),
      openPathInEditor: resolvedArg(undefined),
      logDebugEvent: () => {},
    },
    storage: {
      getPressure: resolved({
        state: "normal" as const,
        freeBytes: 100 * 1024 ** 3,
        totalBytes: 500 * 1024 ** 3,
        freeFraction: 0.2,
        perRoot: [],
        sampledAt: now,
      }),
      getSnapshot: resolvedArg({
        generatedAt: now,
        projectRoot: MOCK_PROJECT.rootPath,
        volume: { freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
        totalAdeBytes: 0,
        categories: [],
        scanDurationMs: 0,
        truncated: false,
        extras: {
          dbBreakdown: [
            { table: "automation_ingress_events", label: "Webhook history", bytes: 12 * 1024 ** 2, category: "webhooks", action: "prunable" },
            { table: "operations", label: "Sync bookkeeping", bytes: 6 * 1024 ** 2, category: "sync_bookkeeping", action: "compactable" },
            { table: "core", label: "Core data", bytes: 8 * 1024 ** 2, category: "core", action: null },
          ],
          maintenance: {
            lastRun: {
              startedAt: now,
              finishedAt: now,
              trigger: "daily",
              actions: [],
              reclaimedBytes: 0,
              dbSizeBytes: 26 * 1024 ** 2,
            },
            journal: [
              {
                startedAt: now,
                finishedAt: now,
                trigger: "daily",
                actions: [],
                reclaimedBytes: 0,
                dbSizeBytes: 26 * 1024 ** 2,
              },
            ],
          },
          safeReclaimableBytes: 18 * 1024 ** 2,
          policyChips: {
            chats_history: "Compressed after 14 days",
            build_release: "Auto-cleans · 7 days",
            caches: "Rebuilt on demand",
          },
        },
      }),
      cleanupPreview: resolvedArg({ items: [], totalBytes: 0, blocked: [] }),
      compressNow: resolvedArg({ filesCompressed: 0, savedBytes: 0 }),
      cleanup: resolvedArg({ removed: [], failed: [], freedBytes: 0 }),
      runMaintenanceNow: resolved({
        startedAt: now,
        finishedAt: now,
        trigger: "manual" as const,
        actions: [],
        reclaimedBytes: 18 * 1024 ** 2,
        dbSizeBytes: 20 * 1024 ** 2,
      }),
    },
    project: {
      openRepo: resolved(MOCK_PROJECT),
      chooseDirectory: resolvedArg(null),
      browseDirectories: async (args?: { inputPath?: string }) => {
        const inputPath =
          typeof args?.inputPath === "string" &&
          args.inputPath.trim().length > 0
            ? args.inputPath
            : "~/";
        return {
          inputPath,
          resolvedPath: "/tmp/mock",
          directoryPath: "/tmp/mock",
          parentPath: "/tmp",
          exactDirectoryPath: "/tmp/mock",
          openableProjectRoot: "/tmp/mock",
          entries: [],
        };
      },
      getDetail: resolvedArg({
        rootPath: MOCK_PROJECT.rootPath,
        isGitRepo: true,
        branchName: MOCK_PROJECT.gitDefaultBranch,
        dirtyCount: 0,
        dirtyBreakdown: null,
        aheadBehind: null,
        lastCommit: null,
        readmeExcerpt: null,
        languages: [],
        laneCount: null,
        lastOpenedAt: null,
        subdirectoryCount: null,
      }),
      getDroppedPath: (_file: unknown) => "",
      openAdeFolder: resolved(undefined),
      clearLocalData: resolved({
        deletedPaths: [],
        clearedAt: new Date().toISOString(),
      }),
      listRecent: resolved([]),
      findForRepo: resolved(null),
      closeCurrent: resolved(undefined),
      resolveIcon: resolvedArg({
        dataUrl: null,
        sourcePath: null,
        mimeType: null,
      }),
      chooseIcon: resolvedArg(null),
      removeIcon: resolvedArg({
        dataUrl: null,
        sourcePath: null,
        mimeType: null,
      }),
      switchToPath: resolvedArg(MOCK_PROJECT),
      forgetRecent: resolvedArg([]),
      reorderRecent: resolvedArg([]),
      setRecentPinned: resolvedArg([]),
      getSnapshot: resolved({
        rootPath: MOCK_PROJECT.rootPath,
        adeDir: `${MOCK_PROJECT.rootPath}/.ade`,
        lastCheckedAt: new Date().toISOString(),
        entries: [],
        health: [],
        cleanup: { changed: false, actions: [] },
        config: {
          sharedPath: `${MOCK_PROJECT.rootPath}/.ade/ade.yaml`,
          localPath: `${MOCK_PROJECT.rootPath}/.ade/local.yaml`,
          secretPath: `${MOCK_PROJECT.rootPath}/.ade/local.secret.yaml`,
          trust: {
            sharedHash: "",
            localHash: "",
          },
        },
      }),
      initializeOrRepair: resolved({ changed: false, actions: [] }),
      runIntegrityCheck: resolved({ changed: false, actions: [] }),
      onMissing: noop,
      onStateEvent: noop,
    },
    remoteRuntime: {
      listTargets: resolved([{
        id: "mock-remote",
        name: "Studio Mac",
        hostname: "studio.local",
        transport: "paired",
        pairedMachine: { hostIdentity: "mock-studio" },
        sshUser: null,
        port: null,
        sshKeyPath: null,
        lastSeenArch: "darwin-arm64",
        runtimeBinaryVersion: "0.0.0-browser",
        lastConnectedAt: Date.now(),
      }]),
      getConnectionSnapshot: resolved({
        connections: [{
          target: {
            id: "mock-remote",
            name: "Studio Mac",
            hostname: "studio.local",
            transport: "paired",
            pairedMachine: { hostIdentity: "mock-studio" },
            sshUser: null,
            port: null,
            sshKeyPath: null,
            lastSeenArch: "darwin-arm64",
            runtimeBinaryVersion: "0.0.0-browser",
            lastConnectedAt: Date.now(),
          },
          state: "connected",
          arch: "darwin-arm64",
          version: "0.0.0-browser",
          route: { kind: "tailnet", endpoint: "100.64.0.2" },
          capabilities: {
            projects: true,
            machineProjects: {
              getDefaultParentDir: true,
              handoffStoragePreflight: true,
              clone: true,
            },
          },
          projects: [],
          lastError: null,
          lastAttemptedAt: Date.now(),
          connectedAt: Date.now(),
        }],
        connectedCount: 1,
        updatedAt: Date.now(),
      }),
      onConnectionSnapshotChanged: noop,
      listDiscoveredMachines: resolved({ machines: [], diagnostics: [] }),
      saveTarget: resolvedArg({
        id: "mock-remote",
        name: "Mock remote",
        hostname: "mock.local",
        sshUser: "ade",
        port: 22,
        sshKeyPath: null,
        lastSeenArch: null,
        runtimeBinaryVersion: null,
        lastConnectedAt: null,
      }),
      setAutoConnect: resolvedArg({
        id: "mock-remote",
        name: "Mock remote",
        hostname: "mock.local",
        sshUser: "ade",
        port: 22,
        sshKeyPath: null,
        lastSeenArch: null,
        runtimeBinaryVersion: null,
        lastConnectedAt: null,
        autoConnect: true,
      }),
      removeTarget: resolvedArg({ removed: true }),
      connect: resolvedArg({
        target: {
          id: "mock-remote",
          name: "Mock remote",
          hostname: "mock.local",
          sshUser: "ade",
          port: 22,
          sshKeyPath: null,
          lastSeenArch: "darwin-arm64",
          runtimeBinaryVersion: "0.0.0-browser",
          lastConnectedAt: Date.now(),
        },
        arch: "darwin-arm64",
        version: "0.0.0-browser",
        projects: [],
      }),
      listProjects: resolvedArg([{
        projectId: "mock-remote-project",
        rootPath: "/Users/ade/Projects/browser-preview",
        displayName: "Browser Preview",
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        gitOriginUrl: "git@github.com:ade/browser-preview.git",
      }]),
      addProject: async (_id: string, rootPath: string) => ({
        projectId: `mock-${
          rootPath
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-|-$/g, "")
            .toLowerCase() || "project"
        }`,
        rootPath,
        displayName:
          rootPath.split(/[\\/]/).filter(Boolean).at(-1) || "Mock project",
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        gitOriginUrl: null,
      }),
      browseDirectories: resolvedArg2({
        inputPath: "",
        resolvedPath: "/Users/ade",
        directoryPath: "/Users/ade",
        parentPath: "/Users",
        exactDirectoryPath: "/Users/ade",
        openableProjectRoot: null,
        entries: [],
      }),
      getProjectDetail: async (_id: string, rootPath: string) => ({
        rootPath,
        isGitRepo: true,
        branchName: "main",
        dirtyCount: 0,
        dirtyBreakdown: null,
        aheadBehind: { ahead: 0, behind: 0 },
        lastCommit: null,
        readmeExcerpt: null,
        languages: [],
        laneCount: 0,
        lastOpenedAt: null,
        subdirectoryCount: 0,
      }),
      getDefaultParentDir: resolved("/Users/ade/Projects"),
      getHandoffStoragePreflight: resolvedArg2({
        parentDir: "/Users/ade/Projects",
        targetPath: "/Users/ade/Projects/browser-preview",
        freeBytes: 128 * 1024 * 1024 * 1024,
        requiredBytes: 1024 * 1024 * 1024,
        hasEnoughSpace: true,
        targetExists: false,
        blockingErrors: [],
        warnings: [],
      }),
      createProject: async (
        _id: string,
        input: { name: string; parentDir: string },
      ) => {
        const rootPath = `${input.parentDir.replace(/\/+$/g, "")}/${input.name}`;
        return {
          projectId: `mock-${input.name}`,
          rootPath,
          displayName: input.name,
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
          gitOriginUrl: null,
        };
      },
      cloneProject: async (
        _id: string,
        input: { url: string; parentDir: string; name?: string },
      ) => {
        const name =
          input.name ||
          input.url
            .split(/[/:]/)
            .pop()
            ?.replace(/\.git$/i, "") ||
          "repo";
        const rootPath = `${input.parentDir.replace(/\/+$/g, "")}/${name}`;
        return {
          projectId: `mock-${name}`,
          rootPath,
          displayName: name,
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
          gitOriginUrl: input.url,
        };
      },
      listMyGitHubRepos: resolvedArg2({ repos: [] }),
      openProject: async (id: string, projectId: string) => ({
        kind: "remote" as const,
        key: remoteProjectBindingKey(id, projectId),
        targetId: id,
        runtimeName: "Mock remote",
        projectId,
        rootPath: "/Users/ade/mock-project",
        displayName: "mock-project",
      }),
      callAction: async (
        _id: string,
        _projectId: string,
        request: RemoteRuntimeActionRequest,
      ) => {
        if (request.domain === "chat" && request.action === "preflightCrossMachineDestination") {
          return {
            domain: request.domain,
            action: request.action,
            result: {
              providerAuthorized: true,
              modelAvailable: true,
              remoteBranchHeadSha: request.args?.sourceHeadSha ?? null,
              existingLaneId: null,
              blockingErrors: [],
              warnings: [],
            },
            statusHints: {},
          };
        }
        if (request.domain === "chat" && request.action === "acceptCrossMachineHandoff") {
          const capsule = request.args?.capsule;
          const handoffId = capsule && typeof capsule === "object" && !Array.isArray(capsule)
            && typeof (capsule as { handoffId?: unknown }).handoffId === "string"
            ? (capsule as { handoffId: string }).handoffId
            : "mock-handoff";
          return {
            domain: request.domain,
            action: request.action,
            result: {
              handoffId,
              laneId: "mock-remote-lane",
              session: {
                id: "mock-remote-chat",
                laneId: "mock-remote-lane",
                provider: "claude",
                model: "claude-sonnet-5",
                status: "active",
                createdAt: new Date().toISOString(),
                lastActivityAt: new Date().toISOString(),
              },
              reusedLane: false,
              reusedSession: false,
            },
            statusHints: {},
          };
        }
        return ({
        domain: request.domain,
        action: request.action,
        result:
          request.domain === "lane" && request.action === "list"
            ? [
                {
                  id: "lane-main",
                  name: "Main",
                  branchName: "main",
                  laneType: "primary",
                },
              ]
            : null,
        statusHints: {},
        });
      },
      streamEvents: resolvedArg({ events: [], nextCursor: 0, hasMore: false }),
      disconnect: resolvedArg({ disconnected: true }),
    },
    keybindings: {
      get: resolved({ definitions: [], overrides: [] }),
      set: resolvedArg({ definitions: [], overrides: [] }),
    },
    sync: {
      getStatus: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      getLocalStatus: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      refreshDiscovery: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      listDevices: resolved([]),
      updateLocalDevice: resolvedArg(BROWSER_MOCK_LOCAL_DEVICE),
      connectToBrain: resolvedArg(BROWSER_MOCK_SYNC_SNAPSHOT),
      disconnectFromBrain: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      forgetDevice: resolvedArg(BROWSER_MOCK_SYNC_SNAPSHOT),
      getTransferReadiness: resolved({
        ready: true,
        blockers: [],
        survivableState: [],
      }),
      transferBrainToLocal: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      getPin: resolved({ pin: null }),
      setPin: resolvedArg(BROWSER_MOCK_SYNC_SNAPSHOT),
      generatePin: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      clearPin: resolved(BROWSER_MOCK_SYNC_SNAPSHOT),
      getRuntimeName: async () => ({ runtimeName: BROWSER_MOCK_SYNC_SNAPSHOT.runtimeName ?? null }),
      setRuntimeName: async (name: string) => {
        const trimmed = String(name ?? "").trim();
        BROWSER_MOCK_SYNC_SNAPSHOT.runtimeName = trimmed || null;
        return BROWSER_MOCK_SYNC_SNAPSHOT;
      },
      clearRuntimeName: async () => {
        BROWSER_MOCK_SYNC_SNAPSHOT.runtimeName = null;
        return BROWSER_MOCK_SYNC_SNAPSHOT;
      },
      setActiveLanePresence: resolvedArg(undefined),
      onEvent: () => () => {},
    },
    ai: {
      getStatus: resolved(BROWSER_MOCK_AI_STATUS),
      getOpenCodeRuntimeDiagnostics: resolved({} as any),
      storeApiKey: resolvedArg(undefined),
      deleteApiKey: resolvedArg(undefined),
      listApiKeys: resolved([]),
      // Machine-scoped provider keys. The preview has no credential store, so
      // report "not configured" rather than letting the card show a key-store
      // failure the user cannot act on in a browser.
      getMachineApiKeyStatus: async (provider: string) => ({
        provider,
        configured: false,
        source: null,
        envVar: "OPENAI_API_KEY",
      }),
      storeMachineApiKey: async (provider: string) => ({
        provider,
        configured: true,
        source: "store" as const,
        envVar: "OPENAI_API_KEY",
      }),
      deleteMachineApiKey: async (provider: string) => ({
        provider,
        configured: false,
        source: null,
        envVar: "OPENAI_API_KEY",
      }),
      verifyApiKey: resolvedArg({
        provider: "mock",
        ok: false,
        message: "browser",
        verifiedAt: now,
      } as any),
      updateConfig: resolvedArg(undefined),
      opencodeAuthMethods: resolved({ methods: {} }),
      opencodeOAuthStart: resolvedArg({ url: "", method: "auto", instructions: "" } as any),
      opencodeOAuthCancel: resolvedArg(undefined),
      setOpencodeProviderKey: resolvedArg({ ok: false, error: "browser" } as any),
      clearOpencodeProviderKey: resolvedArg({ ok: false, error: "browser" } as any),
      refreshModelsDev: resolved({ lastFetchedAt: null }),
      onOpencodeOAuthStatus: () => () => {},
      piLoginProviders: resolved([]),
      piLoginStart: resolvedArg({ ok: false, error: "browser" } as any),
      piLoginSubmit: resolvedArg({ ok: false, error: "browser" } as any),
      piLoginCancel: resolvedArg(undefined),
      onPiAuthStatus: () => () => {},
      cursorAuthStatus: resolved({
        sdkStatus: "logged-out",
        adeKeyPresent: false,
        loginInProgress: false,
      } as any),
      cursorAuthLogin: resolvedArg({ ok: false, error: "browser" } as any),
      cursorAuthLogout: resolvedArg({ ok: false, error: "browser" } as any),
      cursorAuthCancel: resolvedArg(undefined),
      onCursorAuthStatus: () => () => {},
      cursorCloudOpenChat: resolvedArg({ sessionId: "", session: null } as any),
      cursorCloudWatchMirror: resolvedArg(undefined),
    },
    agentTools: {
      detect: resolved([]),
    },
    devTools: {
      detect: resolved(BROWSER_MOCK_DEVTOOLS_CHECK),
    },
    usage: {
      getAdeStats: getBrowserAdeUsageStats,
      getSnapshot: resolved(BROWSER_USAGE_SNAPSHOT),
      refresh: resolved(BROWSER_USAGE_SNAPSHOT),
      refreshHistory: resolved(BROWSER_USAGE_SNAPSHOT),
      noteDemand: resolved(BROWSER_USAGE_SNAPSHOT),
      checkBudget: resolvedArg({
        allowed: true,
        warnings: [] as string[],
      }),
      getCumulativeUsage: resolvedArg({
        totalTokens: 0,
        totalCostUsd: 0,
        weekKey: "2026-W01",
      }),
      consumeResetCredit: async () => ({ ok: true as const, remaining: 0 }),
      getBudgetConfig: resolved(BROWSER_MOCK_BUDGET_CONFIG),
      saveBudgetConfig: resolvedArg(BROWSER_MOCK_BUDGET_CONFIG),
      onUpdate: (cb: (snapshot: any) => void) => {
        queueMicrotask(() => {
          try {
            cb(BROWSER_USAGE_SNAPSHOT);
          } catch {
            // noop
          }
        });
        return () => {};
      },
    },
    /**
     * The browser preview has no `ade-scene:` scheme and no window to capture,
     * so `prepare` hands back a blob URL — a separate origin, with the same
     * policy carried by the document's own meta tag — and the other two say so
     * honestly instead of pretending they filed something.
     */
    scene: {
      prepare: async (html: string) =>
        URL.createObjectURL(new Blob([String(html ?? "")], { type: "text/html" })),
      snapshot: resolvedArg(null),
      attachProof: resolvedArg(false),
    },
    computerUse: {
      listArtifacts: resolvedArg([]),
      getOwnerSnapshot: resolvedArg({} as any),
      updateArtifactReview: resolvedArg({} as any),
      readArtifactPreview: resolvedArg(null),
      mediaBaseUrl: resolved(null),
      // The drawer calls these directly; without them the standalone web
      // renderer throws a TypeError on the delete and recover controls.
      deleteArtifacts: resolvedArg({ deleted: [], missing: [], failed: [], freedBytes: 0 }),
      listBrokenArtifacts: resolvedArg([]),
      pruneBrokenArtifacts: resolvedArg({ deleted: [], missing: [], failed: [], freedBytes: 0 }),
      recoverArtifact: resolvedArg({
        id: "browser-proof-recovered",
        kind: "screenshot",
        backendStyle: "local_fallback",
        backendName: "ADE browser preview",
        sourceToolName: "recover",
        originalType: "image",
        title: "Recovered proof",
        description: null,
        uri: ".ade/artifacts/browser-proof-recovered.png",
        storageKind: "file",
        mimeType: "image/png",
        metadata: {},
        laneId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        links: [],
        reviewState: "pending",
        workflowState: "evidence_only",
        reviewNote: null,
        availability: "available",
      }),
      onEvent: () => () => {},
    },
    onboarding: {
      getStatus: resolved({
        completedAt: new Date().toISOString(),
        dismissedAt: null,
        freshProject: false,
      }),
      detectDefaults: resolved({} as any),
      setDismissed: resolvedArg({
        completedAt: null,
        dismissedAt: new Date().toISOString(),
      } as any),
      complete: resolved({
        completedAt: new Date().toISOString(),
        dismissedAt: null,
      }),
    },
    automations: {
      list: resolved(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.rules)
          ? ADE_DB_AUTOMATIONS.rules
          : [
              {
                id: "auto-session-review",
                name: "PR follow-up thread",
                description:
                  "When a pull request changes, send a focused follow-up prompt to an automation-owned chat thread.",
                enabled: true,
                mode: "review",
                triggers: [{ type: "git.pr_updated", branch: "main" }],
                trigger: { type: "git.pr_updated", branch: "main" },
                execution: {
                  kind: "agent-session",
                  session: { title: "PR follow-up thread" },
                },
                executor: { mode: "automation-bot" },
                modelConfig: {
                    modelId: "anthropic/claude-sonnet-5",
                    thinkingLevel: "medium",
                  },
                permissionConfig: {
                  providers: {
                    opencode: "edit",
                    claude: "plan",
                    codexSandbox: "workspace-write",
                    allowedTools: ["git", "github"],
                  },
                },
                prompt:
                  "Review the latest PR update and leave a concise follow-up summary with any high-signal next steps.",
                reviewProfile: "incremental",
                toolPalette: ["repo", "git", "github"],
                contextSources: [],
                guardrails: {},
                outputs: { disposition: "comment-only", createArtifact: true },
                verification: {
                  verifyBeforePublish: false,
                  mode: "intervention",
                },
                billingCode: "auto:session-review",
                actions: [],
                running: false,
                lastRunAt: now,
                lastRunStatus: "succeeded",
                confidence: {
                  value: 0.84,
                  label: "high",
                  reason:
                    "Recent runs consistently produced concise PR follow-up notes.",
                },
              },
            ],
      ),
      toggle: resolvedArg([]),
      triggerManually: resolvedArg({
        id: "run-1",
        automationId: "auto-session-review",
        chatSessionId: "chat-auto-1",
        triggerType: "manual",
        startedAt: now,
        endedAt: now,
        status: "succeeded",
        executionKind: "agent-session",
        actionsCompleted: 1,
        actionsTotal: 1,
        errorMessage: null,
        spendUsd: 0.42,
        confidence: null,
        triggerMetadata: null,
        summary: "Manual run completed.",
        billingCode: "auto:session-review",
      }),
      getHistory: resolvedArg(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.runs)
          ? ADE_DB_AUTOMATIONS.runs
          : [
              {
                id: "run-1",
                automationId: "auto-session-review",
                chatSessionId: "chat-auto-1",
                triggerType: "git.pr_updated",
                startedAt: now,
                endedAt: now,
                status: "succeeded",
                executionKind: "agent-session",
                actionsCompleted: 1,
                actionsTotal: 1,
                errorMessage: null,
                spendUsd: 1.32,
                confidence: {
                  value: 0.81,
                  label: "high",
                  reason: "Automation summarized the latest PR update clearly.",
                },
                triggerMetadata: { repository: "ADE", branch: "main" },
                summary:
                  "Summarized the latest PR update and suggested next review points.",
                billingCode: "auto:session-review",
              },
            ],
      ),
      getRunDetail: resolvedArg({
        run: {
          id: "run-1",
          automationId: "auto-session-review",
          chatSessionId: "chat-auto-1",
          triggerType: "git.pr_updated",
          startedAt: now,
          endedAt: now,
          status: "succeeded",
          executionKind: "agent-session",
          actionsCompleted: 1,
          actionsTotal: 1,
          errorMessage: null,
          spendUsd: 1.32,
          confidence: {
            value: 0.81,
            label: "high",
            reason: "Automation summarized the latest PR update clearly.",
          },
          triggerMetadata: {
            repository: "ADE",
            branch: "main",
            author: "alice",
          },
          summary:
            "Summarized the latest PR update and suggested next review points.",
          billingCode: "auto:session-review",
        },
        rule: null,
        chatSession: {
          sessionId: "chat-auto-1",
          laneId: "lane-1",
          provider: "claude",
          model: "Claude Sonnet 5",
          modelId: "anthropic/claude-sonnet-5",
          title: "PR follow-up thread",
          surface: "automation",
          automationId: "auto-session-review",
          automationRunId: "run-1",
          status: "idle",
          startedAt: now,
          endedAt: now,
          lastActivityAt: now,
          lastOutputPreview:
            "Summarized the latest PR update and suggested next review points.",
          summary: "Automation-owned chat thread for PR follow-up work.",
        },
        actions: [],
        ingressEvent: {
          id: "ingress-1",
          source: "github-relay",
          eventKey: "delivery-1",
          automationIds: ["auto-session-review"],
          triggerType: "git.pr_updated",
          eventName: "pull_request",
          status: "dispatched",
          summary: "PR synchronize event dispatched to matching rules.",
          errorMessage: null,
          cursor: "cursor-1",
          receivedAt: now,
        },
      }),
      listRuns: resolvedArg(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.runs)
          ? ADE_DB_AUTOMATIONS.runs
          : [
              {
                id: "run-1",
                automationId: "auto-session-review",
                chatSessionId: "chat-auto-1",
                triggerType: "git.pr_updated",
                startedAt: now,
                endedAt: now,
                status: "succeeded",
                executionKind: "agent-session",
                actionsCompleted: 1,
                actionsTotal: 1,
                errorMessage: null,
                spendUsd: 1.32,
                confidence: {
                  value: 0.81,
                  label: "high",
                  reason: "Automation summarized the latest PR update clearly.",
                },
                triggerMetadata: { repository: "ADE", branch: "main" },
                summary:
                  "Summarized the latest PR update and suggested next review points.",
                billingCode: "auto:session-review",
              },
            ],
      ),
      getIngressStatus: resolved({
        webhookGateway: {
          enabled: true,
          ready: true,
          status: "online",
          publicUrl: "https://ade-mock.tailnet.ts.net/ade-webhooks",
          localUrl: "http://127.0.0.1:4319/automations/webhook",
          provider: "tailscale",
          tailscale: {
            available: true,
            hostname: "ade-mock.tailnet.ts.net",
            message: "Tailscale is available on ade-mock.tailnet.ts.net.",
          },
          lastCheckedAt: now,
          lastError: null,
        },
        githubRelay: {
          configured: true,
          healthy: true,
          status: "ready",
          apiBaseUrl: "https://relay.mock",
          remoteProjectId: "proj-123",
          lastCursor: "cursor-1",
          lastPolledAt: now,
          lastDeliveryAt: now,
          lastError: null,
        },
        localWebhook: {
          configured: true,
          listening: true,
          status: "listening",
          url: "http://127.0.0.1:4319/automations/webhook",
          githubUrl: "http://127.0.0.1:4319/github-webhooks",
          port: 4319,
          lastDeliveryAt: now,
          lastError: null,
        },
      }),
      refreshWebhookGatewayStatus: resolved({
        enabled: true,
        ready: true,
        status: "online",
        publicUrl: "https://ade-mock.tailnet.ts.net/ade-webhooks",
        localUrl: "http://127.0.0.1:4319/automations/webhook",
        provider: "tailscale",
        tailscale: {
          available: true,
          hostname: "ade-mock.tailnet.ts.net",
          message: "Tailscale is available on ade-mock.tailnet.ts.net.",
        },
        lastCheckedAt: now,
        lastError: null,
      }),
      setWebhookGatewayPublicUrl: resolvedArg({
        enabled: true,
        ready: true,
        status: "online",
        publicUrl: "https://ade-mock.tailnet.ts.net/ade-webhooks",
        localUrl: "http://127.0.0.1:4319/automations/webhook",
        provider: "tailscale",
        tailscale: {
          available: true,
          hostname: "ade-mock.tailnet.ts.net",
          message: "Tailscale is available on ade-mock.tailnet.ts.net.",
        },
        lastCheckedAt: now,
        lastError: null,
      }),
      listIngressEvents: resolvedArg(
        USE_ADE_DB_SNAPSHOT && Array.isArray(ADE_DB_AUTOMATIONS?.ingressEvents)
          ? ADE_DB_AUTOMATIONS.ingressEvents
          : [
              {
                id: "ingress-1",
                source: "github-relay",
                eventKey: "delivery-1",
                automationIds: ["auto-session-review"],
                triggerType: "git.pr_updated",
                eventName: "pull_request",
                status: "dispatched",
                summary: "PR synchronize event dispatched to matching rules.",
                errorMessage: null,
                cursor: "cursor-1",
                receivedAt: now,
              },
            ],
      ),
      parseNaturalLanguage: resolvedArg({
        draft: {
          name: "Mock automation",
          description: "",
          enabled: true,
          mode: "review",
          triggers: [{ type: "manual" }],
          trigger: { type: "manual" },
          execution: { kind: "agent-session", session: {} },
          executor: { mode: "automation-bot" },
          prompt: "Review the latest changes.",
          reviewProfile: "quick",
          toolPalette: ["repo"],
          contextSources: [],
          guardrails: {},
          outputs: { disposition: "comment-only", createArtifact: true },
          verification: { verifyBeforePublish: false, mode: "intervention" },
          billingCode: "auto:mock",
          actions: [],
          legacyActions: [],
        },
        normalized: null,
        confidence: 0.6,
        ambiguities: [],
        resolutions: [],
        issues: [],
        plannerCommandPreview: "codex automation planner preview",
      }),
      validateDraft: resolvedArg({
        ok: true,
        normalized: null,
        issues: [],
        requiredConfirmations: [],
      }),
      saveDraft: resolvedArg({ rule: { id: "mock-rule" }, rules: [] }),
      simulate: resolvedArg({
        normalized: null,
        actions: [],
        notes: ["Mock simulation"],
        issues: [],
      }),
      onEvent: noop,
    },
    actions: {
      listRegistry: resolved([]),
    },
    lanes: {
      list: resolved(MOCK_LANES),
      listSnapshots: async () =>
        MOCK_LANES.map((lane) => makeLaneSnapshot(lane)),
      create: resolvedArg({ id: "mock", name: "mock" }),
      createChild: resolvedArg({ id: "mock", name: "mock" }),
      importBranch: resolvedArg({ id: "mock", name: "mock" }),
      previewBranchSwitch: resolvedArg({
        laneId: "mock",
        currentBranchRef: "main",
        targetBranchRef: "main",
        mode: "existing",
        dirty: false,
        duplicateLaneId: null,
        duplicateLaneName: null,
        activeWork: [],
        targetProfile: null,
      }),
      switchBranch: resolvedArg({
        lane: MOCK_LANES[0],
        previousBranchRef: "main",
        activeWork: [],
      }),
      rename: resolvedArg(undefined),
      reparent: resolvedArg({}),
      updateAppearance: resolvedArg(undefined),
      archive: resolvedArg(undefined),
      archiveAndReclaim: resolvedArg({
        laneId: "",
        reclaimedBytes: 0,
        worktreeRemoved: true,
        generatedDataRemoved: true,
        warnings: [],
      }),
      unarchive: resolvedArg({ lane: MOCK_LANES[0], worktreeRecreated: false }),
      delete: resolvedArg(undefined),
      listDeleteProgress: resolved([]),
      cancelDelete: resolvedArg({
        cancelled: false,
        reason: "no active delete",
      }),
      getDeleteRisk: resolvedArg({
        laneId: "mock",
        branchRef: null,
        dirty: false,
        hasUnpushedCommits: false,
        unpushedCommitCount: 0,
        remoteBranchExists: false,
        activeChatCount: 0,
        activePtyCount: 0,
        activeWatcherCount: 0,
        envInitialized: false,
      }),
      getReclaimRisk: resolvedArg({
        laneId: "",
        laneName: "Lane",
        branchRef: null,
        worktreePath: "",
        dirty: false,
        hasUnpushedCommits: false,
        unpushedCommitCount: 0,
        remoteBranchExists: false,
        activeChatCount: 0,
        activePtyCount: 0,
        activeWatcherCount: 0,
        envInitialized: false,
        worktreeBytes: 0,
        generatedBytes: 0,
        reclaimableBytes: 0,
        worktreeAvailable: false,
        blockedReasons: [],
        lastFailure: null,
        retryCount: 0,
      }),
      onDeleteEvent: noop,
      onLifecycleEvent: noop,
      getStackChain: resolvedArg([]),
      getChildren: resolvedArg([]),
      rebaseStart: resolvedArg({
        runId: "mock-run",
        run: {
          runId: "mock-run",
          rootLaneId: "mock",
          scope: "lane_only",
          pushMode: "none",
          state: "completed",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          actor: "user",
          baseBranch: "main",
          lanes: [],
          currentLaneId: null,
          failedLaneId: null,
          error: null,
          pushedLaneIds: [],
          canRollback: false,
        },
      }),
      rebasePush: resolvedArg({
        runId: "mock-run",
        rootLaneId: "mock",
        scope: "lane_only",
        pushMode: "none",
        state: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actor: "user",
        baseBranch: "main",
        lanes: [],
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false,
      }),
      rebaseRollback: resolvedArg({
        runId: "mock-run",
        rootLaneId: "mock",
        scope: "lane_only",
        pushMode: "none",
        state: "aborted",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actor: "user",
        baseBranch: "main",
        lanes: [],
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false,
      }),
      rebaseAbort: resolvedArg({
        runId: "mock-run",
        rootLaneId: "mock",
        scope: "lane_only",
        pushMode: "none",
        state: "aborted",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actor: "user",
        baseBranch: "main",
        lanes: [],
        currentLaneId: null,
        failedLaneId: null,
        error: null,
        pushedLaneIds: [],
        canRollback: false,
      }),
      rebaseSubscribe: noop,
      listRebaseSuggestions: resolved([]),
      dismissRebaseSuggestion: resolvedArg(undefined),
      deferRebaseSuggestion: resolvedArg(undefined),
      onRebaseSuggestionsEvent: noop,
      listAutoRebaseStatuses: resolved([]),
      dismissAutoRebaseStatus: resolvedArg(undefined),
      onAutoRebaseEvent: noop,
      openFolder: resolvedArg(undefined),
      revealWorktree: resolvedArg(undefined),
      revealLeftoverWorktree: resolvedArg(undefined),
      deleteLeftoverWorktree: resolvedArg({ removed: false }),
      initEnv: resolvedArg({
        laneId: "mock",
        steps: [],
        startedAt: now,
        completedAt: now,
        overallStatus: "completed",
      }),
      getEnvStatus: resolvedArg(null),
      getOverlay: resolvedArg({}),
      onEnvEvent: noop,
      listTemplates: resolved([]),
      getTemplate: resolvedArg(null),
      getDefaultTemplate: resolvedArg(null),
      setDefaultTemplate: resolvedArg(undefined),
      applyTemplate: resolvedArg({
        laneId: "mock",
        steps: [],
        startedAt: now,
        completedAt: now,
        overallStatus: "completed",
      }),
      portGetLease: resolvedArg(null),
      portListLeases: resolved([]),
      portAcquire: resolvedArg({
        laneId: "mock",
        rangeStart: 3000,
        rangeEnd: 3099,
        status: "active",
        leasedAt: now,
      }),
      portRelease: resolvedArg(undefined),
      portListConflicts: resolved([]),
      portRecoverOrphans: resolved([]),
      onPortEvent: noop,
      proxyGetStatus: resolved({
        running: false,
        proxyPort: 8080,
        routes: [],
      }),
      proxyStart: resolvedArg({
        running: true,
        proxyPort: 8080,
        routes: [],
        startedAt: now,
      }),
      proxyStop: resolvedArg(undefined),
      proxyAddRoute: resolvedArg({
        laneId: "mock",
        hostname: "mock.localhost",
        targetPort: 3000,
        status: "active",
        createdAt: now,
      }),
      proxyRemoveRoute: resolvedArg(undefined),
      proxyGetPreviewInfo: resolvedArg({
        laneId: "mock",
        hostname: "mock.localhost",
        previewUrl: "http://mock.localhost:8080",
        proxyPort: 8080,
        targetPort: 3000,
        active: false,
      }),
      proxyOpenPreview: resolvedArg(undefined),
      oauthGetStatus: resolved({
        enabled: false,
        routingMode: "state-parameter" as const,
        activeSessions: [],
        callbackPaths: [],
      }),
      oauthUpdateConfig: resolvedArg(undefined),
      oauthGenerateRedirectUris: resolvedArg([
        { provider: "google", uris: [] as string[], instructions: "" },
      ]),
      oauthEncodeState: resolvedArg("ade:mock"),
      oauthDecodeState: resolvedArg(null),
      oauthListSessions: resolved([]),
      onOAuthEvent: noop,
      diagnosticsGetStatus: resolved({
        lanes: [],
        proxyRunning: false,
        proxyPort: 8080,
        totalRoutes: 0,
        activeConflicts: 0,
        fallbackLanes: [] as string[],
      }),
      diagnosticsGetLaneHealth: async (args: { laneId: string }) =>
        typeof args?.laneId === "string"
          ? mockBrowserLaneHealth(args.laneId)
          : null,
      diagnosticsRunHealthCheck: async (args: { laneId: string }) =>
        mockBrowserLaneHealth(
          typeof args?.laneId === "string" ? args.laneId : "mock",
        ),
      diagnosticsRunFullCheck: resolved([]),
      diagnosticsActivateFallback: resolvedArg(undefined),
      diagnosticsDeactivateFallback: resolvedArg(undefined),
      onDiagnosticsEvent: noop,
      onProxyEvent: noop,
    },
    sessions: {
      list: async (args: any = {}) => {
        let rows = MOCK_SESSIONS;
        if (typeof args?.laneId === "string" && args.laneId.trim()) {
          rows = rows.filter(
            (session) => session.laneId === args.laneId.trim(),
          );
        }
        if (typeof args?.status === "string" && args.status.trim()) {
          rows = rows.filter(
            (session) => session.status === args.status.trim(),
          );
        }
        const limit = Number.isFinite(args?.limit)
          ? Math.max(1, Math.floor(args.limit))
          : rows.length;
        return rows.slice(0, limit);
      },
      get: async (sessionId: string) =>
        MOCK_SESSIONS.find((session) => session.id === sessionId) ?? null,
      delete: resolvedArg(undefined),
      updateMeta: resolvedArg(null),
      readTranscriptTail: async (args: any = {}) => {
        const sessionId = String(args?.sessionId ?? "").trim();
        const lines = getMockChatTranscriptEvents(sessionId).map((entry) =>
          JSON.stringify(entry),
        );
        const raw = lines.join("\n");
        const maxBytes = Number.isFinite(args?.maxBytes)
          ? Math.max(0, Math.floor(args.maxBytes))
          : raw.length;
        return raw.length > maxBytes
          ? raw.slice(Math.max(0, raw.length - maxBytes))
          : raw;
      },
      getDelta: resolvedArg(null),
      onChanged: noop,
    },
    personalChats: {
      call: async ({ action, args = {} }: any) => {
        let result: any = null;
        if (action === "list") {
          result = browserMockPersonalChats.filter(
            (chat) => args.includeArchived === true || !chat.archivedAt,
          );
        }
        if (action === "modelCatalog") result = { groups: [], fetchedAt: new Date().toISOString() };
        if (action === "models") result = [];
        if (action === "create") {
          const now = new Date().toISOString();
          result = {
            sessionId: `personal-browser-${Date.now()}-${++browserMockPersonalChatSequence}`,
            title: args.title ?? null,
            goal: null,
            summary: null,
            lastOutputPreview: null,
            provider: args.provider ?? "codex",
            model: args.model ?? DEFAULT_BROWSER_MOCK_CODEX_MODEL,
            modelId: args.modelId ?? DEFAULT_BROWSER_MOCK_CODEX_MODEL,
            status: "idle",
            surface: "personal",
            permissionMode: args.permissionMode ?? "default",
            reasoningEffort: args.reasoningEffort ?? null,
            fastMode: args.fastMode === true,
            startedAt: now,
            endedAt: null,
            archivedAt: null,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
          };
          browserMockPersonalChats.unshift(result);
          browserMockPersonalChatEvents.set(result.sessionId, []);
        }
        if (action === "getSummary") result = browserMockPersonalChats.find((chat) => chat.sessionId === args.sessionId) ?? null;
        if (action === "read") {
          const events = browserMockPersonalChatEvents.get(args.sessionId) ?? [];
          const entries: any[] = events.flatMap((envelope): any[] => {
            if (envelope.event?.type === "user_message") {
              return [{
                role: "user",
                text: envelope.event.text ?? "",
                displayText: envelope.event.displayText,
                timestamp: envelope.timestamp,
                turnId: envelope.event.turnId,
                messageId: envelope.event.messageId,
              }];
            }
            if (envelope.event?.type === "text") {
              return [{
                role: "assistant",
                text: envelope.event.text ?? "",
                timestamp: envelope.timestamp,
                turnId: envelope.event.turnId,
                itemId: envelope.event.itemId,
              }];
            }
            return [];
          });
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : entries.length;
          result = entries.slice(-limit);
        }
        if (action === "send") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const turnId = `personal-turn-${Date.now()}-${++browserMockPersonalChatSequence}`;
          const timestamp = new Date().toISOString();
          const text = String(args.text ?? "").trim();
          const responseText = text
            ? `Browser preview received: ${text}`
            : "Browser preview received your message.";
          if (chat) {
            Object.assign(chat, {
              status: "idle",
              lastOutputPreview: responseText,
              updatedAt: timestamp,
              lastActivityAt: timestamp,
            });
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "user_message",
              text,
              displayText: args.displayText ?? text,
              attachments: args.attachments ?? [],
              turnId,
              messageId: `personal-message-${++browserMockPersonalChatSequence}`,
            });
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "status", turnStatus: "started", turnId });
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "text",
              text: responseText,
              turnId,
              itemId: `personal-text-${++browserMockPersonalChatSequence}`,
            });
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "status", turnStatus: "completed", turnId });
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "done",
              turnId,
              status: "completed",
              model: chat.model,
              modelId: chat.modelId,
            });
          }
          result = { accepted: Boolean(chat), sessionId: args.sessionId, turnId };
        }
        if (action === "steer") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const steerId = `personal-steer-${Date.now()}-${++browserMockPersonalChatSequence}`;
          if (chat) {
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "user_message",
              text: String(args.text ?? ""),
              displayText: args.displayText ?? args.text ?? "",
              attachments: args.attachments ?? [],
              steerId,
              deliveryState: "queued",
            });
            chat.lastActivityAt = new Date().toISOString();
          }
          result = { queued: Boolean(chat), sessionId: args.sessionId, steerId };
        }
        if (action === "interrupt") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const turnId = `personal-interrupt-${Date.now()}-${++browserMockPersonalChatSequence}`;
          if (chat) {
            chat.status = "idle";
            chat.lastActivityAt = new Date().toISOString();
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "status", turnStatus: "interrupted", turnId });
            appendBrowserMockPersonalChatEvent(chat.sessionId, { type: "done", turnId, status: "interrupted" });
          }
          result = { interrupted: Boolean(chat), sessionId: args.sessionId };
        }
        if (action === "approve" || action === "respondToInput") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          const normalizedDecision = String(args.decision ?? "").toLowerCase();
          const resolution = normalizedDecision === "approve" || normalizedDecision === "accept" || normalizedDecision === "accepted"
            ? "accepted"
            : normalizedDecision === "deny" || normalizedDecision === "decline" || normalizedDecision === "declined"
              ? "declined"
              : "cancelled";
          if (chat && args.itemId) {
            appendBrowserMockPersonalChatEvent(chat.sessionId, {
              type: "pending_input_resolved",
              itemId: args.itemId,
              resolution,
            });
            chat.awaitingInput = false;
            chat.pendingInputItemId = null;
            chat.status = "idle";
          }
          result = { ok: Boolean(chat), sessionId: args.sessionId, itemId: args.itemId ?? null, resolution };
        }
        if (action === "getEventHistory") {
          result = {
            sessionId: args.sessionId ?? "",
            events: [...(browserMockPersonalChatEvents.get(args.sessionId) ?? [])],
            truncated: false,
            sessionFound: browserMockPersonalChats.some((chat) => chat.sessionId === args.sessionId),
          };
        }
        if (action === "getEventHistoryPage") {
          result = {
            sessionId: args.sessionId ?? "",
            events: [],
            startOffset: 0,
            hasMore: false,
            sessionFound: browserMockPersonalChats.some((chat) => chat.sessionId === args.sessionId),
          };
        }
        if (action === "updateSession") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          if (chat) Object.assign(chat, args, { updatedAt: new Date().toISOString() });
          result = chat ?? null;
        }
        if (action === "terminalCreate") {
          const id = `personal-terminal-${Date.now()}`;
          result = { ptyId: id, sessionId: id, pid: null };
        }
        if (action === "terminalWrite") result = { ok: true };
        if (action === "terminalResize") result = { ok: true, cols: args.cols, rows: args.rows };
        if (action === "terminalDispose") result = { disposed: true, reason: "disposed" };
        if (action === "archive") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          if (chat) Object.assign(chat, { archivedAt: new Date().toISOString(), status: "ended" });
          result = { ok: Boolean(chat) };
        }
        if (action === "unarchive") {
          const chat = browserMockPersonalChats.find((entry) => entry.sessionId === args.sessionId);
          if (chat) Object.assign(chat, { archivedAt: null, status: "idle", updatedAt: new Date().toISOString() });
          result = { ok: Boolean(chat) };
        }
        if (action === "delete") {
          const index = browserMockPersonalChats.findIndex((chat) => chat.sessionId === args.sessionId);
          if (index >= 0) {
            browserMockPersonalChats.splice(index, 1);
            browserMockPersonalChatEvents.delete(args.sessionId);
          }
          result = { ok: index >= 0 };
        }
        return { action, result };
      },
      streamEvents: async ({ cursor = 0 }: any = {}) => ({ events: [], nextCursor: cursor, hasMore: false }),
    },
    chatLaunch: {
      start: async (args: any = {}) => startBrowserMockChatLaunch(args),
      get: async (args: any = {}) => browserMockChatLaunches.get(String(args?.launchId)) ?? null,
      list: async () => [...browserMockChatLaunches.values()],
      cancel: async (args: any = {}) => {
        const launch = browserMockChatLaunches.get(String(args?.launchId));
        if (!launch) return null;
        if (launch.phase === "cancelled") return launch;
        if (launch.agentStarted || launch.phase === "completed") {
          throw new Error("This chat already started — delete its lane from the lane menu instead.");
        }
        return emitBrowserMockChatLaunch({ ...launch, phase: "cancelled", queuedMessages: [], endedAt: new Date().toISOString() });
      },
      retry: async (args: any = {}) => browserMockChatLaunches.get(String(args?.launchId)) ?? null,
      startNow: async (args: any = {}) => browserMockChatLaunches.get(String(args?.launchId)) ?? null,
      queueMessage: async (args: any = {}) => {
        const launch = browserMockChatLaunches.get(String(args?.launchId));
        if (!launch) throw new Error(`Launch not found: ${String(args?.launchId)}`);
        return emitBrowserMockChatLaunch({
          ...launch,
          queuedMessages: [
            ...launch.queuedMessages,
            toQueuedMessage(
              { text: String(args.text ?? ""), displayText: args.displayText ? String(args.displayText) : null },
              { id: `mock-queued-${Date.now()}`, createdAt: new Date().toISOString() },
            ),
          ],
        });
      },
      completeClient: async (args: any = {}) => {
        const launch = browserMockChatLaunches.get(String(args?.launchId));
        if (!launch) return null;
        const now = new Date().toISOString();
        return emitBrowserMockChatLaunch({
          ...launch,
          sessionId: args.sessionId ?? launch.sessionId,
          phase: args.error ? "failed" : "completed",
          error: args.error ?? null,
          agentStarted: !args.error,
          endedAt: args.error ? null : now,
          stages: launch.stages.map((stage) => (stage.id === "agent"
            ? { ...stage, status: args.error ? "failed" : "done", startedAt: stage.startedAt ?? now, endedAt: now, error: args.error ?? null }
            : stage)),
        });
      },
      onEvent: (listener: (event: ChatLaunchEvent) => void) => {
        browserMockChatLaunchListeners.add(listener);
        return () => {
          browserMockChatLaunchListeners.delete(listener);
        };
      },
    },
    agentChat: {
      list: async (args: any = {}) => listMockAgentChatSummaries(args),
      getSummary: async (args: any = {}) => {
        const sessionId = String(args?.sessionId ?? "").trim();
        const session = MOCK_SESSIONS.find((row) => row.id === sessionId);
        return mockAgentChatSummaryFromSession(session) ?? null;
      },
      create: resolvedArg({ id: "mock" }),
      suggestLaneName: resolvedArg("browser-mock-chat"),
      generateAutoLaneIdentity: async (args: any = {}) => ({
        laneTitle: String(args.fallbackName ?? "Browser Mock Chat"),
        branchFragment: "browser-mock-chat",
        source: "deterministic",
        laneRenameOutcome: "skipped",
        branchRenameOutcome: "skipped",
        branchRef: String(args.temporaryBranch ?? ""),
        reason: "browser_mock",
      }),
      parallelLaunchState: {
        get: resolvedArg(null),
        set: resolvedArg(undefined),
      },
      promptStashes: {
        list: async (_pin?: OpenProjectBinding | null) => browserMockPromptStashes.map((entry) => ({
          ...entry,
          attachments: entry.attachments?.map((attachment) => ({ ...attachment })),
        })),
        create: async (args: PromptStashCreateArgs, _pin?: OpenProjectBinding | null) => {
          const attachments = (args.attachments ?? []).map((attachment) => ({ ...attachment }));
          const entry: PromptStashEntry = {
            id: globalThis.crypto.randomUUID(),
            text: args.text,
            attachments,
            attachmentCount: attachments.length,
            attachmentsAvailable: true,
            provider: args.provider ?? null,
            modelId: args.modelId ?? null,
            createdAt: new Date().toISOString(),
          };
          browserMockPromptStashes.unshift(entry);
          browserMockPromptStashes.splice(MAX_PROMPT_STASHES);
          return entry;
        },
        delete: async ({ id }: { id: string }, _pin?: OpenProjectBinding | null) => {
          const index = browserMockPromptStashes.findIndex((entry) => entry.id === id);
          if (index < 0) return false;
          browserMockPromptStashes.splice(index, 1);
          return true;
        },
      },
      handoff: resolvedArg({ session: { id: "mock" }, events: [] }),
      prepareCrossMachineHandoff: async (args: AgentChatPrepareCrossMachineHandoffArgs) => ({
        capsule: {
          version: 1,
          handoffId: args.handoffId,
          createdAt: new Date().toISOString(),
          source: {
            machineName: "Browser Preview",
            sessionId: args.sourceSessionId,
            provider: "claude",
            model: "claude-sonnet-5",
            title: "Browser preview parity",
            laneName: "main",
            branchRef: "main",
            headSha: "1234567890abcdef1234567890abcdef12345678",
            originUrl: "git@github.com:ade/browser-preview.git",
          },
          target: {
            targetModelId: args.targetModelId,
            reasoningEffort: args.reasoningEffort,
            fastMode: args.fastMode,
            claudePermissionMode: args.claudePermissionMode,
            codexApprovalPolicy: args.codexApprovalPolicy,
            codexSandbox: args.codexSandbox,
            codexConfigSource: args.codexConfigSource,
            opencodePermissionMode: args.opencodePermissionMode,
            droidPermissionMode: args.droidPermissionMode,
            permissionMode: args.permissionMode,
            cursorModeId: args.cursorModeId,
          },
          brief: "## Current goal\n- Continue polishing the browser preview handoff flow.\n\n## Important decisions and preserved context\n- Keep the setup clear and failure-aware.\n\n## Files, commands, and errors to preserve\n- apps/desktop/src/renderer/components/chat/CrossMachineHandoffModal.tsx\n\n## Next action or open issue\n- Verify the destination handoff UI.",
          artifacts: { fileChanges: [], commands: [], errors: [] },
          linearIssues: [],
          continuationPrompt: args.continuationPrompt?.trim() || "Continue from the handoff brief.",
        },
        capsuleFingerprint: "a".repeat(64),
        usedFallbackSummary: false,
        sanitizedSensitiveContext: false,
      }),
      validateCrossMachineSource: resolvedArg(undefined),
      markCrossMachineHandoff: resolvedArg(undefined),
      send: resolvedArg(undefined),
      steer: async () => ({
        steerId: globalThis.crypto.randomUUID(),
        queued: true,
      }),
      cancelSteer: resolvedArg(undefined),
      editSteer: resolvedArg(undefined),
      dispatchSteer: resolvedArg({
        delivered: false,
        reason: "Browser mock does not run chat sessions.",
      }),
      cancelDispatchedSteer: resolvedArg({ cancelled: false }),
      interrupt: resolvedArg<AgentChatInterruptResult>({
        mode: "stop_and_clear",
        cancelledQueuedCount: 0,
      }),
      stopTask: resolvedArg({ sessionId: "", taskId: "", stopped: false }),
      restoreCancelledQueue: resolvedArg<AgentChatRestoreCancelledQueueResult>({
        restored: false,
        restoredCount: 0,
      }),
      recoverTurn: async (
        args: AgentChatRecoverTurnArgs,
      ): Promise<AgentChatRecoverTurnResult> => ({
        action: args.action,
        turnId: args.turnId,
        status: args.action === "wait"
          ? "waiting"
          : args.action === "nudge"
            ? "nudged"
            : args.action === "restart_resume"
              ? "resumed"
              : "retrying",
      }),
      recoverCodexTurn: async (
        args: AgentChatRecoverCodexTurnArgs,
      ): Promise<AgentChatRecoverCodexTurnResult> => ({
        action: args.action,
        turnId: args.turnId,
        status: args.action === "wait"
          ? "waiting"
          : args.action === "steer"
            ? "nudged"
            : args.action === "restart_resume_thread"
              ? "resumed"
              : "retrying",
      }),
      resolveUnprocessedMessage: async (
        args: AgentChatResolveUnprocessedMessageArgs,
      ): Promise<AgentChatResolveUnprocessedMessageResult> => ({
        steerId: args.steerId,
        action: args.action,
        status: "completed",
      }),
      approve: resolvedArg(undefined),
      respondToInput: resolvedArg(undefined),
      dismissPendingInput: resolvedArg(undefined),
      models: resolvedArg([]),
      modelCatalog: resolvedArg({ groups: [], fetchedAt: new Date(0).toISOString() }),
      archive: resolvedArg(undefined),
      unarchive: resolvedArg(undefined),
      delete: resolvedArg(undefined),
      updateSession: resolvedArg({ id: "mock" }),
      regenerateSessionMetadata: resolvedArg({
        sessionId: "mock",
        applied: [],
        skipped: ["title", "laneName", "statusLine"],
        modelId: null,
      }),
      createScheduledWork: async () => {
        throw new Error("Scheduled work is unavailable in the browser preview.");
      },
      listScheduledWork: resolved([]),
      cancelScheduledWork: async () => {
        throw new Error("Scheduled work is unavailable in the browser preview.");
      },
      setScheduledWorkPaused: async (args: { sessionId: string; paused: boolean }) => ({
        sessionId: args.sessionId,
        paused: args.paused,
        nextWakeAt: null,
      }),
      warmupModel: resolvedArg(undefined),
      onEvent: noop,
      slashCommands: resolvedArg([]),
      listClaudePlugins: resolvedArg([]),
      listCodexPlugins: resolvedArg([]),
      reloadClaudePlugins: resolvedArg({
        plugins: [],
        commands: [],
        agents: [],
        errorCount: 0,
      }),
      listClaudeOutputStyles: resolvedArg([
        { name: "Default", source: "builtin" },
        { name: "Proactive", source: "builtin" },
        { name: "Explanatory", source: "builtin" },
        { name: "Learning", source: "builtin" },
      ]),
      setClaudeOutputStyle: resolvedArg({
        id: "mock",
        provider: "claude",
        claudeOutputStyle: "Default",
      }),
      listClaudeSessions: resolvedArg([]),
      getClaudeSessionInfo: resolvedArg(null),
      getClaudeSessionMessages: resolvedArg([]),
      getMainTranscript: resolvedArg(null),
      getSubagentTranscript: resolvedArg(null),
      getContextUsage: resolvedArg(null),
      rewindFiles: resolvedArg({
        canRewind: false,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        dryRun: true,
      }),
      fileSearch: resolvedArg([]),
      // Composer @-mention suggestions. Mirrors the real action's contract
      // (per-kind cap + shared ranking) off the mock rosters so the sectioned
      // @ menu is exercisable in the Vite-only preview.
      listMentionSuggestions: async (
        args: ChatMentionSuggestArgs = {},
        _pin?: OpenProjectBinding | null,
      ): Promise<ChatMentionSuggestResult> => {
        const query = typeof args.query === "string" ? args.query : "";
        const epoch = (value: unknown): number | null => {
          const parsed = Date.parse(String(value ?? ""));
          return Number.isFinite(parsed) ? parsed : null;
        };
        const chats: ChatMentionSuggestion[] = MOCK_SESSIONS
          .filter((row) => !row.archivedAt && row.id !== args.excludeSessionId)
          .filter((row) => String(row.toolType ?? "").includes("chat"))
          .map((row) => ({
            kind: "chat" as const,
            id: String(row.id),
            title: String(row.title ?? row.goal ?? `Chat ${String(row.id).slice(0, 8)}`),
            subtitle: [row.laneName, row.status].filter(Boolean).join(" · "),
            lastActivityAt: epoch(row.endedAt) ?? epoch(row.startedAt),
          }));
        const lanes: ChatMentionSuggestion[] = MOCK_LANES
          .filter((row) => !row.archivedAt)
          .map((row) => ({
            kind: "lane" as const,
            id: String(row.id),
            title: String(row.name),
            subtitle: String(row.branchRef ?? ""),
            lastActivityAt: epoch(row.createdAt),
          }));
        const terminals: ChatMentionSuggestion[] = MOCK_SESSIONS
          .filter((row) => !row.archivedAt && row.ptyId && !String(row.toolType ?? "").includes("chat"))
          .map((row) => ({
            kind: "terminal" as const,
            id: String(row.id),
            title: String(row.title ?? row.goal ?? `Terminal ${String(row.id).slice(0, 8)}`),
            subtitle: [row.laneName, row.status].filter(Boolean).join(" · "),
            lastActivityAt: epoch(row.endedAt) ?? epoch(row.startedAt),
          }));
        const byKind: Record<ChatMentionKind, ChatMentionSuggestion[]> = {
          chat: chats,
          lane: lanes,
          terminal: terminals,
        };
        return {
          suggestions: rankChatMentionSuggestions(
            CHAT_MENTION_KINDS.flatMap((kind) =>
              rankChatMentionSuggestions(byKind[kind], query, CHAT_MENTION_MAX_PER_KIND)),
            query,
            CHAT_MENTION_MAX_RESULTS,
          ),
        };
      },
      getTurnFileDiff: resolvedArg(null),
      listSubagents: resolvedArg([]),
      killDroidWorker: resolvedArg(undefined),
      getSessionCapabilities: resolvedArg({
        supportsSubagentInspection: false,
        supportsSubagentControl: false,
        supportsReviewMode: false,
        subagent: {
          canList: false,
          canViewFullTranscript: false,
          statsFields: [],
          kinds: [],
          hasRichMetadata: false,
        },
      }),
      saveTempAttachment: resolvedArg({ path: "/tmp/browser-mock-attachment" }),
      // Vite-only preview runs in a browser: no webUtils, so no real path.
      getAttachmentStagingMode: resolvedArg({
        mode: "base64" as const,
        maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
      }),
      stageFileAttachment: async () => {
        throw new Error("Attachment upload is not available in the browser preview.");
      },
      getImageDataUrl: resolvedArg({ dataUrl: BROWSER_MOCK_IMAGE_DATA_URL }),
      resolveSmartLinkPreview: async ({ url }: { url: string }) => deriveSmartLinkPreview(url),
      resolveSourceFavicons: async () => ({ icons: {} }),
      getEventHistory: async (arg: {
        sessionId: string;
        maxEvents?: number;
      }) => {
        const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId : "";
        const events = getMockChatTranscriptEvents(sessionId);
        const maxEvents = Number.isFinite(arg?.maxEvents)
          ? Math.max(1, Math.floor(arg.maxEvents!))
          : events.length;
        const omitted = Math.max(0, events.length - maxEvents);
        return {
          sessionId,
          events: omitted > 0 ? events.slice(omitted) : events,
          truncated: omitted > 0,
          hasOlderHistory: omitted > 0,
          tailStartOffset: omitted > 0 ? omitted : null,
        };
      },
      getEventHistoryPage: async (arg: {
        sessionId: string;
        beforeOffset: number;
        maxBytes?: number;
      }) => {
        const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId : "";
        const events = getMockChatTranscriptEvents(sessionId);
        const before = Number.isFinite(arg?.beforeOffset)
          ? Math.max(0, Math.floor(arg.beforeOffset))
          : 0;
        const older = events.slice(0, Math.min(before, events.length));
        const maxBytes = Number.isFinite(arg?.maxBytes) && arg.maxBytes! > 0
          ? arg.maxBytes!
          : 256 * 1024;
        const page: typeof older = [];
        let bytes = 0;
        for (let index = older.length - 1; index >= 0; index -= 1) {
          const raw = JSON.stringify(older[index]);
          if (page.length > 0 && bytes + raw.length > maxBytes) break;
          page.push(older[index]!);
          bytes += raw.length;
          if (page.length >= 200) break;
        }
        page.reverse();
        const startOffset = older.length - page.length;
        return {
          sessionId,
          events: page,
          startOffset,
          hasMore: startOffset > 0,
          sessionFound: events.length > 0,
        };
      },
    },
    appControl: createMockAppControl(),
    iosSimulator: {
      /*
       * Supported, with a device list, so the Apple picker renders in the web
       * preview (jsdom computes no layout). Five simulators on one runtime, two
       * booted, one held by another lane.
       */
      getStatus: resolved({
        platform: "darwin",
        supported: true,
        tools: [],
        activeDevice: null,
        activeSession: null,
        deviceSession: null,
        laneDevice: null,
        helper: { present: true, path: "/mock/ade-sim-helper", version: "mock" },
      }),
      deviceList: resolvedArg({
        installed: BROWSER_MOCK_SIMULATORS,
        lane: null,
        owners: [{
          udid: "repro",
          laneId: "lane-other",
          laneName: "Repro fix",
          origin: "attached",
          mine: false,
        }],
        disk: {
          totalBytes: 18 * 1024 ** 3,
          devices: [
            { udid: "pro", bytes: 5 * 1024 ** 3 },
            { udid: "repro", bytes: 2 * 1024 ** 3 },
            { udid: "pad", bytes: 3.2 * 1024 ** 3 },
          ],
          root: "/mock/devices",
          measuredAt: "2026-09-22T00:00:00.000Z",
        },
      } as any),
      deviceStart: resolvedArg({} as any),
      deviceStop: resolvedArg(undefined as any),
      deviceCreate: resolvedArg({} as any),
      deviceAttach: resolvedArg({} as any),
      deviceDelete: resolvedArg(undefined as any),
      deviceDetach: resolvedArg(null as any),
      deviceDeleteInstalled: resolvedArg(undefined as any),
      listDevices: resolved([]),
      listLaunchTargets: resolved([]),
      launch: resolvedArg({} as any),
      attachToChatSession: resolved(null),
      shutdown: resolvedArg({ ok: true } as any),
      screenshot: resolvedArg({} as any),
      getScreenSnapshot: resolvedArg({} as any),
      getInspectorSnapshot: resolved(null),
      inspectPoint: resolvedArg({} as any),
      getPreviewCapability: resolvedArg(BROWSER_MOCK_PREVIEW_CAPABILITY_UNSUPPORTED as any),
      listPreviewTargets: resolved([]),
      resolvePreviewMatch: resolvedArg({
        status: "no-context",
        target: null,
        confidence: "none",
        reason: "Browser preview has no iOS simulator context.",
        selectedSourceFile: null,
        selectedSourceLine: null,
        suggestedTitle: null,
        suggestedSourceFile: null,
        suggestedSourceFilePath: null,
      } as any),
      ensurePreviewWorkspace: resolvedArg({
        ok: false,
        opened: false,
        path: null,
        capability: BROWSER_MOCK_PREVIEW_CAPABILITY_UNSUPPORTED,
        error: "Browser preview cannot manage Xcode.",
      } as any),
      renderCurrentPreview: resolvedArg({
        ok: false,
        match: {
          status: "no-context",
          target: null,
          confidence: "none",
          reason: "Browser preview has no iOS simulator context.",
          selectedSourceFile: null,
          selectedSourceLine: null,
          suggestedTitle: null,
          suggestedSourceFile: null,
          suggestedSourceFilePath: null,
        },
        target: null,
        render: null,
        error: "Browser preview cannot manage Xcode.",
      } as any),
      renderPreview: resolvedArg({} as any),
      openPreviewWorkspace: resolved({ ok: true as const, path: "/tmp" }),
      startStream: resolvedArg({ streaming: false, streamUrl: null, transport: null } as any),
      stopStream: resolvedArg({ streaming: false, streamUrl: null } as any),
      getStreamStatus: resolvedArg({ streaming: false, streamUrl: null } as any),
      tap: resolved({ ok: true as const }),
      typeText: resolved({ ok: true as const }),
      drag: resolved({ ok: true as const }),
      swipe: resolved({ ok: true as const }),
      selectPoint: resolvedArg({} as any),
      openDevice: resolvedArg({
        deviceUdid: "browser-mock-device",
        deviceName: "Browser preview",
        chatSessionId: null,
        laneId: null,
        openedAt: now,
        bootedByAde: false,
      }),
      closeDevice: resolvedArg({
        released: false,
        shutdown: false,
        previousDeviceSession: null,
      }),
      getDeviceSettings: resolvedArg(BROWSER_MOCK_IOS_DEVICE_SETTINGS),
      setAppearance: resolvedArg(BROWSER_MOCK_IOS_DEVICE_SETTINGS),
      setContentSize: resolvedArg(BROWSER_MOCK_IOS_DEVICE_SETTINGS),
      setAccessibilityOption: resolvedArg(BROWSER_MOCK_IOS_DEVICE_SETTINGS),
      setLocation: resolvedArg(BROWSER_MOCK_IOS_DEVICE_SETTINGS),
      clearLocation: resolvedArg(BROWSER_MOCK_IOS_DEVICE_SETTINGS),
      setPermission: resolvedArg({ ok: true as const }),
      sendPushNotification: resolvedArg({ ok: true as const }),
      openUrl: resolvedArg({ ok: true as const }),
      relaunchApp: resolvedArg({
        bundleId: "com.example.app",
        running: false,
        pid: null,
        checkedAt: now,
      }),
      terminateApp: resolvedArg({ ok: true as const }),
      uninstallApp: resolvedArg({ ok: true as const }),
      setStatusBar: resolvedArg({ ok: true as const }),
      clearStatusBar: resolvedArg({ ok: true as const }),
      getAppState: resolvedArg({
        bundleId: "com.ade.browser-mock",
        running: false,
        pid: null,
        checkedAt: now,
      }),
      getForegroundApp: resolvedArg(null),
      startEventLog: resolvedArg(BROWSER_MOCK_IOS_LOG_PAGE),
      stopEventLog: resolved(BROWSER_MOCK_IOS_LOG_PAGE),
      getEventLog: resolvedArg(BROWSER_MOCK_IOS_LOG_PAGE),
      findElement: resolvedArg(browserMockIosElementResult("assert")),
      tapElement: resolvedArg(browserMockIosElementResult("tap")),
      fillElement: resolvedArg(browserMockIosElementResult("fill")),
      waitForElement: resolvedArg(browserMockIosElementResult("wait")),
      assertVisible: resolvedArg(browserMockIosElementResult("assert")),
      captureProofBundle: resolvedArg({
        dir: "/tmp",
        screenshotPath: "/tmp/ios-proof.png",
        metadataPath: "/tmp/ios-proof.json",
        elementsPath: null,
        logPath: null,
        caption: null,
        capturedAt: now,
      }),
      resolveStreamUrl: resolvedArg({ url: null, forwarded: false, error: null }),
      onEvent: () => () => {},
    },
    /**
     * Mac Desktop in the hosted web client: `getStatus` answers honestly with
     * `supported: false`, which is what hides the tab, and every other method
     * is a stub nothing on this surface calls. The namespace has to EXIST —
     * the Work pane reads the capability on mount, and an undefined namespace
     * would throw there rather than hide a tool.
     */
    macDesktop: {
      getStatus: resolvedArg({
        platform: "browser" as unknown as NodeJS.Platform,
        supported: false,
        unsupportedReason: "The hosted web client cannot host a Mac display.",
        driver: {
          state: "unsupported" as const,
          title: "Not available here",
          message: "Mac Desktop runs on the machine that hosts the lane.",
          recovery: null,
          version: null,
        },
        permissions: { screenRecording: "unknown" as const, accessibility: "unknown" as const },
        displayMode: "unavailable" as const,
        display: null,
        windows: [],
        lease: null,
        stream: null,
        recording: null,
        lanes: [],
        hostIsLocal: false,
      }),
      start: resolvedArg(null as never),
      stop: resolvedArg({ stopped: false, releasedWindows: 0 }),
      listWindows: resolvedArg([]),
      open: resolvedArg(null as never),
      claimWindow: resolvedArg(null as never),
      releaseWindow: resolvedArg({ released: 0 }),
      observe: resolvedArg(null as never),
      click: resolvedArg(null as never),
      type: resolvedArg(null as never),
      press: resolvedArg(null as never),
      scroll: resolvedArg(null as never),
      drag: resolvedArg(null as never),
      wait: resolvedArg(null as never),
      screenshot: resolvedArg(null as never),
      startRecording: resolvedArg(null as never),
      stopRecording: resolvedArg(null as never),
      startStream: resolvedArg(null as never),
      stopStream: resolvedArg(null as never),
      getStreamStatus: resolvedArg(null as never),
      takeControl: resolvedArg(null as never),
      returnControl: resolvedArg(null),
      renewLease: resolvedArg(null),
      present: resolvedArg({ moved: 0 }),
      resolveStreamUrl: resolvedArg({ url: null, forwarded: false, error: null }),
      onEvent: () => () => {},
    },
    builtInBrowser: {
      getStatus: resolved({
        attached: false,
        partition: "persist:ade-browser",
        storageProfileKey: "global",
        collectionKey: "personal",
        collectionProjectRoot: null,
        persistentProfile: true,
        visible: false,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        activeTabId: null,
        tabs: [],
        url: null,
        title: null,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        isInspecting: false,
        hasSelection: false,
        ownerLaneId: null,
        ownerChatSessionId: null,
        ownerClaimedAt: null,
        ownerLeaseExpiresAt: null,
      }),
      requestOriginAccess: resolvedArg({
        origin: null,
        required: false,
        granted: true,
        status: {} as any,
      }),
      getProfileDiagnostics: resolved({
        partition: "persist:ade-browser",
        storageProfileKey: "global" as const,
        persistentProfile: true as const,
        cookieCount: 0,
        persistentCookieCount: 0,
        sessionCookieCount: 0,
        cookieDomains: [],
        cacheSizeBytes: 0,
        persistedPermissionDecisionCount: 0,
        tabRestorationEnabled: false,
        lastStorageFlushAt: null,
      }),
      listPermissions: resolved({ permissions: [] }),
      clearPermissions: resolvedArg({ removed: 0, permissions: [] }),
      agentAccess: createMockBrowserAgentAccess(),
      loginImport: {
        capabilities: resolved({ platform: "other" as const, anySupported: false, browsers: [] }),
        listSources: resolved({
          platform: "other" as const,
          sources: [],
          capabilities: { platform: "other" as const, anySupported: false, browsers: [] },
        }),
        // Shape-conforming, like the hosted web client's stub: `{} as any`
        // handed a preview run an object with none of `ok`/`sourceId`/`status`,
        // which is a different failure from "not available here".
        listDomains: resolvedArg(LOGIN_IMPORT_UNAVAILABLE),
        import: resolvedArg(LOGIN_IMPORT_UNAVAILABLE),
      },
      claim: resolvedArg({} as any),
      showPanel: resolvedArg({} as any),
      setBounds: resolvedArg({} as any),
      navigate: resolvedArg({} as any),
      createTab: resolvedArg({} as any),
      switchTab: resolvedArg({} as any),
      closeTab: resolvedArg({} as any),
      reload: resolvedArg({} as any),
      goBack: resolvedArg({} as any),
      goForward: resolvedArg({} as any),
      stop: resolvedArg({} as any),
      startInspect: resolvedArg({} as any),
      stopInspect: resolved(async () => {}),
      captureScreenshot: resolvedArg({} as any),
      selectPoint: resolvedArg({} as any),
      selectCurrent: resolvedArg({} as any),
      clearSelection: resolved({ ok: true as const }),
      onEvent: () => () => {},
    },
    terminal: {
      list: async (_args: any = {}) => [] as any[],
      read: async () => ({ output: "", truncated: false, exitCode: null }),
      preview: async () => ({ output: "", truncated: false }),
      write: resolved({ ok: true as const }),
      signal: resolved({ ok: true as const }),
      activeForChat: async () => null,
      reattachChatCli: async () => ({
        ok: false as const,
        reason: "Browser mock does not attach chat CLI terminals.",
      }),
    },
    cto: {
      getAttention: resolved({ status: "idle", awaitingInput: false, since: null }),
      getState: resolvedArg({
        identity: ADE_DB_SNAPSHOT?.ctoState?.identity ?? {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          updatedAt: now,
        },
        recentSessions: ADE_DB_SNAPSHOT?.ctoState?.recentSessions ?? [],
      }),
      getOnboardingState: resolved({
        completedSteps: ["identity"],
        completedAt: now,
      }),
      completeOnboardingStep: resolvedArg({
        completedSteps: ["identity"],
        completedAt: now,
      }),
      getMemory: resolved({
        memory: [
          "## Facts",
          "- We ship desktop releases from tagged commits on main.",
          "- The team prefers concise status updates with next actions.",
          "- Current focus: hardening the mobile sync transport.",
        ].join("\n"),
        threadState:
          "_Updated just now (compaction)_\n- Reviewing PR queue health.\n- Open loop: flaky sync test on CI.",
        dailyLog: "09:12 — Asked for PR queue summary → 3 PRs ready, 1 blocked on CI.",
        dailyLogDate: now.slice(0, 10),
        updatedAt: now,
        projectBrief: [
          "Goal: Keep one CTO who already knows this project.",
          "Done when: A new idea can be handed over without restating the repo.",
          "Constraints: The CTO directs agents. It does not commit the repository.",
          "Open loops: Account copy still uploads from the brain process.",
        ].join("\n"),
        projectItems: [
          "- (pinned) Desktop releases ship from tagged commits on main.",
          "- (active) The team prefers concise status updates with a next action.",
          "- (active) Current focus is the mobile sync transport.",
        ].join("\n"),
        projectThreads: "- Sync transport · lane lane-sync · chat chat-sync · Harden the phone sync path",
      }),
      updateMemory: async (arg: { memory?: string }) => ({
        memory: arg?.memory ?? "",
        threadState: "",
        dailyLog: "",
        dailyLogDate: now.slice(0, 10),
        updatedAt: now,
        projectBrief: [
          "Goal: Keep one CTO who already knows this project.",
          "Done when: A new idea can be handed over without restating the repo.",
          "Constraints: The CTO directs agents. It does not commit the repository.",
          "Open loops: Account copy still uploads from the brain process.",
        ].join("\n"),
        projectItems: [
          "- (pinned) Desktop releases ship from tagged commits on main.",
          "- (active) The team prefers concise status updates with a next action.",
          "- (active) Current focus is the mobile sync transport.",
        ].join("\n"),
        projectThreads: "- Sync transport · lane lane-sync · chat chat-sync · Harden the phone sync path",
      }),
      searchMemory: resolvedArg({ query: "", rows: [] }),
      ensureSession: resolvedArg({
        id: "mock-cto-session",
        laneId: "lane-main",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
        capabilityMode: "full_tooling",
        status: "idle",
        createdAt: now,
        lastActivityAt: now,
      }),
      listSessionLogs: resolvedArg([]),
      updateIdentity: resolvedArg({
        identity: {
          name: "CTO",
          version: 1,
          persona: "Mock CTO persona",
          modelPreferences: { provider: "claude", model: "sonnet" },
          updatedAt: now,
        },
        recentSessions: [],
      }),
      previewSystemPrompt: resolvedArg({
        prompt: "You are the CTO for this project inside ADE.",
        tokenEstimate: 10,
        sections: [
          {
            id: "doctrine",
            title: "Immutable ADE doctrine",
            content: "You are the CTO for this project inside ADE.",
          },
          {
            id: "continuity",
            title: "Continuity model",
            content: "CTO continuity uses the current project context.",
          },
          {
            id: "capabilities",
            title: "Capability manifest",
            content: "ADE capabilities are exposed through registered tools.",
          },
        ],
      }),
      getLinearProjects: resolvedArg(MOCK_LINEAR_PROJECTS),
      getLinearQuickView: resolvedArg({
        connection: MOCK_LINEAR_CONNECTION,
        organization: {
          id: "mock-linear-org",
          name: "ADE",
          urlKey: "ade",
          logoUrl: null,
          gitBranchFormat: null,
          createdIssueCount: 128,
          roadmapEnabled: true,
          customersEnabled: false,
          releasesEnabled: true,
        },
        viewer: {
          id: "mock-linear-user",
          name: "Mock Linear User",
          displayName: "Mock Linear User",
          email: "mock@example.com",
          avatarUrl: null,
          admin: true,
          guest: false,
          url: null,
        },
        projects: [
          {
            id: "mock-linear-project",
            name: "Desktop polish",
            slug: "desktop-polish",
            teamName: "ADE",
            teamKey: "ADE",
            url: "https://linear.app/ade/project/desktop-polish",
            color: "#5E6AD2",
            icon: null,
            description: "Mock Linear project",
            statusName: "Started",
            statusType: "started",
            health: "onTrack",
            progress: 0.42,
            scope: 21,
            priority: 2,
            priorityLabel: "High",
            issueCount: 9,
            completedIssueCount: 4,
            startDate: null,
            targetDate: null,
            leadName: "Mock Linear User",
            teamKeys: ["ADE"],
          },
        ],
        teams: [
          {
            id: "mock-linear-team",
            key: "ADE",
            name: "ADE",
            displayName: "ADE",
            color: "#5E6AD2",
            issueCount: 32,
            cyclesEnabled: true,
            private: false,
          },
        ],
        assignedIssues: MOCK_LINEAR_ISSUES,
        recentIssues: MOCK_LINEAR_ISSUES,
        fetchedAt: now,
        sdk: {
          packageName: "@linear/sdk",
          surfaces: [
            "viewer",
            "organization",
            "projects",
            "teams",
            "assignedIssues",
            "issues",
          ],
        },
      }),
      getLinearIssuePickerData: resolvedArg(MOCK_LINEAR_PICKER),
      searchLinearIssues: resolvedArg({
        issues: MOCK_LINEAR_ISSUES,
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      getLinearConnectionStatus: resolvedArg(MOCK_LINEAR_CONNECTION),
      setLinearToken: resolvedArg({
        ...MOCK_LINEAR_CONNECTION,
        authMode: "manual" as const,
        message: "Linear token accepted in browser preview.",
      }),
      clearLinearToken: resolvedArg({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        organizationId: null,
        organizationName: null,
        organizationUrlKey: null,
        organizationLogoUrl: null,
        projectCount: 0,
        projectPreview: [],
        checkedAt: now,
        authMode: null,
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: "Linear disconnected in browser preview.",
      }),
      setLinearOAuthClient: resolvedArg({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: now,
        authMode: null,
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: "Linear OAuth configured.",
      }),
      clearLinearOAuthClient: resolvedArg({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: now,
        authMode: null,
        oauthAvailable: false,
        tokenExpiresAt: null,
        message: "Linear OAuth configuration cleared.",
      }),
      startLinearOAuth: resolvedArg({
        sessionId: "linear-oauth-mock",
        authUrl: "https://linear.app/oauth/authorize",
        redirectUri: "http://127.0.0.1:3000/oauth/callback",
      }),
      getLinearOAuthSession: resolvedArg({
        status: "completed",
        connection: {
          tokenStored: true,
          connected: true,
          viewerId: "viewer-mock",
          viewerName: "Mock Linear User",
          checkedAt: now,
          authMode: "oauth",
          oauthAvailable: true,
          tokenExpiresAt: null,
          message: null,
        },
      }),
    },
    externalSessions: createMockExternalSessionsApi(() => MOCK_LANES),
    // Stateful on purpose: the accounts UI adds, renames and removes rows, and
    // a stub that always returned the same two entries would make every one of
    // those interactions look broken in the Vite-only preview.
    apiCredentials: {
      list: async (args?: ApiCredentialListArgs) =>
        mockApiCredentials.filter((row) => !args?.provider || row.provider === args.provider),
      get: async (args: ApiCredentialGetArgs) =>
        mockApiCredentials.find(
          (row) => row.provider === args.provider
            && row.credentialId === (args.credentialId ?? "default"),
        ) ?? null,
      store: async (args: ApiCredentialStoreArgs) => {
        const credentialId = args.credentialId
          ?? `${args.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-mock`;
        const stamp = new Date().toISOString();
        const next: ApiCredentialSummary = {
          provider: args.provider,
          credentialId,
          label: args.label,
          ...(args.envVar ? { envVar: args.envVar } : {}),
          ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
          ...(args.protocol ? { protocol: args.protocol } : {}),
          ...(args.models?.length ? { models: args.models } : {}),
          source: "store",
          createdAt: stamp,
          updatedAt: stamp,
          maskedTail: `••••${args.key.slice(-4)}`,
        };
        const index = mockApiCredentials.findIndex(
          (row) => row.provider === args.provider && row.credentialId === credentialId,
        );
        if (index >= 0) mockApiCredentials.splice(index, 1, next);
        else mockApiCredentials.push(next);
        return next;
      },
      remove: async (args: ApiCredentialRemoveArgs) => {
        const index = mockApiCredentials.findIndex(
          (row) => row.provider === args.provider
            && row.credentialId === (args.credentialId ?? "default"),
        );
        if (index >= 0) mockApiCredentials.splice(index, 1);
      },
    },
    proxy: {
      status: async () => ({
        installed: false,
        running: false,
        port: null,
        version: null,
        logins: [],
      }),
      ensureRunning: async () => ({
        installed: false,
        running: false,
        port: null,
        version: null,
        logins: [],
      }),
      signIn: async () => ({
        status: "error" as const,
        error: "Subscription sign-in needs the ADE desktop app.",
      }),
      signOut: async () => ({ ok: true as const }),
      setDisabled: async () => ({ ok: true as const }),
    },
    providerInstances: {
      list: async (args?: { provider?: "claude" | "codex" }) =>
        mockProviderInstances.filter((instance) => !args?.provider || instance.provider === args.provider),
      create: async (args: { provider: "claude" | "codex"; label: string; accentColor?: string }) => {
        const instance = {
          id: `${args.provider}-${mockProviderInstances.length + 1}`,
          provider: args.provider,
          label: args.label,
          ...(args.accentColor ? { accentColor: args.accentColor } : {}),
          configHome: `/mock/.ade/provider-homes/${args.provider}/${mockProviderInstances.length + 1}`,
          isDefault: false,
          createdAt: now,
          signedIn: false,
        };
        mockProviderInstances.push(instance);
        return { instance, loginCommand: mockProviderInstanceLoginCommand(instance) };
      },
      remove: async (args: { id: string }) => {
        const index = mockProviderInstances.findIndex((instance) => instance.id === args.id);
        const configHome = index >= 0 ? mockProviderInstances[index]!.configHome : "";
        if (index >= 0) mockProviderInstances.splice(index, 1);
        return { removed: index >= 0, configHome };
      },
      rename: async (args: { id: string; label: string }) => {
        const instance = mockProviderInstanceById(args.id);
        instance.label = args.label;
        return instance;
      },
      setDefault: async (args: { id: string }) => {
        const instance = mockProviderInstanceById(args.id);
        for (const other of mockProviderInstances) {
          if (other.provider === instance.provider) other.isDefault = other.id === instance.id;
        }
        return instance;
      },
      setAccent: async (args: { id: string; accentColor: string | null }) => {
        const instance = mockProviderInstanceById(args.id);
        if (args.accentColor) instance.accentColor = args.accentColor;
        else delete instance.accentColor;
        return instance;
      },
      getSettings: async (args: { provider: "claude" | "codex" }) =>
        ({ ...mockProviderInstanceSettings[args.provider] }),
      setSettings: async (args: {
        provider: "claude" | "codex";
        settings: { smartBalance?: boolean; autoStartWindows?: boolean };
      }) => {
        const current = mockProviderInstanceSettings[args.provider];
        if (typeof args.settings?.smartBalance === "boolean") current.smartBalance = args.settings.smartBalance;
        if (typeof args.settings?.autoStartWindows === "boolean") {
          current.autoStartWindows = args.settings.autoStartWindows;
        }
        return { ...current };
      },
      loginCommand: async (args: { id: string }) =>
        mockProviderInstanceLoginCommand(mockProviderInstanceById(args.id)),
      refresh: async (args?: { provider?: "claude" | "codex" }) =>
        mockProviderInstances.filter((instance) => !args?.provider || instance.provider === args.provider),
    },
    pty: {
      create: resolvedArg({
        ptyId: "mock",
        sessionId: "mock-session",
        pid: 1234,
      }),
      sendToSession: resolvedArg({
        ptyId: "mock",
        sessionId: "mock-session",
        pid: 1234,
        session: null,
        resumed: false,
        reusedExistingRuntime: true,
      }),
      write: resolvedArg(undefined),
      resize: resolvedArg(undefined),
      dispose: resolvedArg(undefined),
      setDataSubscriptions: resolvedArg(undefined),
      onData: noop,
      onExit: noop,
    },
    diff: {
      getChanges: resolvedArg({ unstaged: [], staged: [] }),
      getFile: resolvedArg({
        path: "",
        mode: "unstaged" as const,
        original: { exists: false, text: "" },
        modified: { exists: false, text: "" },
      }),
    },
    // Every real `files` method takes an optional trailing machine `pin`. The
    // browser mock models a single synthetic machine, so it accepts the pin to
    // keep the surface identical and then ignores it — there is nowhere else to
    // route to.
    files: {
      writeTextAtomic: resolvedArg2(undefined),
      listWorkspaces: resolvedArg2(getBrowserMockFilesWorkspaces()),
      listTree: async (args: any, _pin?: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const parentPath = normalizeBrowserMockRelPath(args?.parentPath);
        return getBrowserMockListTreeNodes(workspaceId, parentPath);
      },
      listTreeChildren: async (args: any, _pin?: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const parentPath = normalizeBrowserMockRelPath(args?.parentPath);
        const all = getBrowserMockListTreeNodes(workspaceId, parentPath);
        const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.floor(args.limit)) : 500;
        const pageEnd = Math.min(offset + limit, all.length);
        return {
          parentPath,
          children: all.slice(offset, pageEnd),
          offset,
          limit,
          total: all.length,
          nextOffset: pageEnd < all.length ? pageEnd : null,
        };
      },
      refreshGitDecorations: async (args: any, _pin?: any) => ({
        workspaceId: String(args?.workspaceId ?? ""),
        files: [],
        directories: [],
      }),
      openExternalPath: async () => {
        throw new Error("External local files are not available in the browser mock.");
      },
      readFile: async (args: any, _pin?: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const relPath = String(args?.path ?? "");
        return getBrowserMockReadFilePayload(workspaceId, relPath);
      },
      readFileRange: async (args: any, _pin?: any) => {
        const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        return {
          path: String(args?.path ?? ""),
          encoding: "utf-8" as const,
          content: "",
          rangeStart: offset,
          rangeEnd: offset,
          totalSize: offset,
          nextOffset: null,
          eof: true,
        };
      },
      gitBlame: async (args: any, _pin?: any) => ({ path: String(args?.path ?? ""), lines: [] }),
      writeText: resolvedArg2(undefined),
      createFile: resolvedArg2(undefined),
      createDirectory: resolvedArg2(undefined),
      rename: resolvedArg2(undefined),
      delete: resolvedArg2(undefined),
      watchChanges: resolvedArg2(undefined),
      stopWatching: resolvedArg2(undefined),
      quickOpen: async (args: any, _pin?: any) => {
        const workspaceId = String(args?.workspaceId ?? "");
        const q = String(args?.query ?? "")
          .trim()
          .toLowerCase();
        const limit = Number.isFinite(args?.limit)
          ? Math.max(1, Math.floor(args.limit))
          : 25;
        const rootNodes = getBrowserMockListTreeNodes(workspaceId, "");
        const flat: { path: string; score: number }[] = [];
        const maxCollect = 400;
        const walk = (nodes: any[], prefixScore: number) => {
          if (flat.length >= maxCollect) return;
          for (const node of nodes) {
            if (!node?.path) continue;
            const hay = String(node.path).toLowerCase();
            if (!q || hay.includes(q)) {
              flat.push({
                path: node.path,
                score: prefixScore + (node.name?.length ?? 0),
              });
            }
            if (node.type === "directory") {
              const kids = getBrowserMockListTreeNodes(workspaceId, node.path);
              if (kids.length) walk(kids, prefixScore + 1);
            }
            if (flat.length >= maxCollect) return;
          }
        };
        walk(rootNodes, 0);
        if (!q) {
          // Mirror the real index service: an empty query browses the
          // workspace shallowest-path-first, tie-broken by path.
          const depthOf = (p: string) => p.split(/[/\\]/).length;
          flat.sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path));
        }
        return flat.slice(0, limit);
      },
      searchText: resolvedArg2([]),
      onChange: noop,
    },
    git: {
      stageFile: resolvedArg({ ok: true }),
      stageAll: resolvedArg({ ok: true }),
      unstageFile: resolvedArg({ ok: true }),
      unstageAll: resolvedArg({ ok: true }),
      discardFile: resolvedArg({ ok: true }),
      restoreStagedFile: resolvedArg({ ok: true }),
      commit: resolvedArg({ ok: true }),
      listRecentCommits: async (args: any = {}) =>
        mockLaneRecentCommits(args) ?? [
          {
            sha: "abcdef1234567890",
            shortSha: "abcdef1",
            parents: [],
            authorName: "ADE Browser Mock",
            authoredAt: now,
            subject: "Browser mock HEAD commit",
            pushed: true,
          },
        ],
      listCommitFiles: resolvedArg([]),
      getCommitMessage: async (args: any = {}) =>
        MOCK_COMMIT_MESSAGES.get(String(args?.commitSha ?? "")) ?? "",
      getCommit: resolvedArg(null),
      isCommitInLaneHistory: resolvedArg(true),
      revertCommit: resolvedArg({ ok: true }),
      cherryPickCommit: resolvedArg({ ok: true }),
      createTag: resolvedArg({ ok: true }),
      resetToCommit: resolvedArg({ ok: true }),
      stashPush: resolvedArg({ ok: true }),
      stashList: resolvedArg([]),
      stashApply: resolvedArg({ ok: true }),
      stashPop: resolvedArg({ ok: true }),
      stashDrop: resolvedArg({ ok: true }),
      fetch: resolvedArg({ ok: true }),
      pull: resolvedArg({ ok: true }),
      undoLastHeadChange: resolvedArg({ ok: true }),
      redoLastHeadChange: resolvedArg({ ok: true }),
      getSyncStatus: resolvedArg({
        hasUpstream: true,
        upstreamState: "tracking",
        upstreamRef: "origin/main",
        ahead: 0,
        behind: 0,
        diverged: false,
        recommendedAction: "none",
      }),
      getSyncStatuses: async (args: GitSyncStatusesArgs) => Object.fromEntries(
        (Array.isArray(args?.laneIds) ? args.laneIds : []).map((laneId: string) => [laneId, {
          hasUpstream: true,
          upstreamState: "tracking",
          upstreamRef: "origin/main",
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "none",
        }]),
      ),
      getOriginRemote: resolvedArg({
        remoteUrl: "git@github.com:ade/browser-preview.git",
        branch: "main",
      }),
      getUserIdentity: resolvedArg({ name: "Mock User", email: "mock@example.com" }),
      sync: resolvedArg({ ok: true }),
      push: resolvedArg({ ok: true }),
      getConflictState: resolvedArg({ hasConflicts: false }),
      rebaseContinue: resolvedArg({ ok: true }),
      rebaseAbort: resolvedArg({ ok: true }),
      mergeContinue: resolvedArg({ ok: true }),
      mergeAbort: resolvedArg({ ok: true }),
      listBranches: resolvedArg([]),
      checkoutBranch: resolvedArg({ ok: true }),
    },
    conflicts: {
      getLaneStatus: resolvedArg({ status: "clean" }),
      listOverlaps: resolvedArg([]),
      getRiskMatrix: resolved([]),
      runPrediction: resolved({ assessments: [] }),
      listProposals: resolvedArg([]),
      prepareProposal: resolvedArg({}),
      requestProposal: resolvedArg({}),
      applyProposal: resolvedArg({}),
      undoProposal: resolvedArg({}),
      runExternalResolver: resolvedArg({}),
      listExternalResolverRuns: resolved([]),
      commitExternalResolverRun: resolvedArg({}),
      prepareResolverSession: resolvedArg({}),
      attachResolverSession: resolvedArg({}),
      finalizeResolverSession: resolvedArg({}),
      cancelResolverSession: resolvedArg({}),
      suggestResolverTarget: resolvedArg({}),
      onEvent: noop,
    },
    context: {
      getStatus: resolved({ initialized: false }),
      generateDocs: resolvedArg({}),
      openDoc: resolvedArg(undefined),
    },
    feedback: {
      prepareDraft: resolvedArg({
        category: "bug",
        draftInput: {
          category: "bug",
          summary: "Mock feedback",
          stepsToReproduce: "",
          expectedBehavior: "",
          actualBehavior: "",
          environment: "",
          additionalContext: "",
        },
        userDescription: "## Summary\n\nMock feedback",
        modelId: null,
        reasoningEffort: null,
        title: "Mock feedback",
        body: "## Description\n\nMock feedback",
        labels: ["bug"],
        generationMode: "deterministic",
        generationWarning:
          "ADE used a deterministic draft because no AI model was selected.",
      }),
      submitDraft: resolvedArg({
        id: "mock-feedback-1",
        category: "bug",
        userDescription: "Mock feedback",
        modelId: null,
        status: "posted",
        generationMode: null,
        generationWarning: null,
        generatedTitle: null,
        generatedBody: null,
        issueUrl: null,
        issueNumber: null,
        issueState: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      }),
      list: resolved([]),
      onUpdate: () => () => {},
    },
    github: {
      getStatus: resolved({
        tokenStored: true,
        patTokenStored: false,
        tokenDecryptionFailed: false,
        storageScope: "app",
        authSource: "app",
        writeAuthSource: "gh",
        tokenType: "oauth",
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
        userLogin: "arul",
        scopes: ["repo", "workflow"],
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
        checkedAt: new Date().toISOString(),
        authFailure: null,
        rateLimit: null,
        credentialStates: [
          {
            source: "environment",
            available: false,
            capabilities: ["read", "write"],
            activeFor: [],
            state: "unavailable",
            failure: null,
            rateLimit: null,
          },
          {
            source: "app",
            available: true,
            capabilities: ["read"],
            activeFor: ["read"],
            state: "active",
            failure: null,
            rateLimit: null,
          },
          {
            source: "gh",
            available: true,
            capabilities: ["read", "write"],
            activeFor: ["write"],
            state: "active",
            failure: null,
            rateLimit: null,
          },
          {
            source: "pat",
            available: false,
            capabilities: ["read", "write"],
            activeFor: [],
            state: "unavailable",
            failure: null,
            rateLimit: null,
          },
        ],
        credentialFallback: null,
        backgroundRefreshPausedUntil: null,
        repoAccessOk: true,
        repoAccessError: null,
        connected: true,
      }),
      getRemoteStatus: resolved({
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
      }),
      setToken: resolvedArg({
        tokenStored: true,
        patTokenStored: true,
        tokenDecryptionFailed: false,
        storageScope: "app",
        authSource: "pat",
        tokenType: "classic",
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
        userLogin: "arul",
        scopes: ["repo", "workflow"],
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
        checkedAt: new Date().toISOString(),
        repoAccessOk: true,
        repoAccessError: null,
        connected: true,
      }),
      clearToken: resolved({
        tokenStored: false,
        patTokenStored: false,
        tokenDecryptionFailed: false,
        storageScope: "app",
        authSource: "none",
        tokenType: "unknown",
        repo: { owner: "arul28", name: "ADE" },
        hasOrigin: true,
        userLogin: null,
        scopes: [],
        ghCliPath: "/opt/homebrew/bin/gh",
        ghAuthError: null,
        checkedAt: null,
        repoAccessOk: null,
        repoAccessError: null,
        connected: false,
      }),
      getAppUserAuthStatus: resolved({
        configured: true,
        tokenStored: true,
        userLogin: "arul",
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        credentialState: "authorized",
        refreshBlockedUntil: null,
        lastRefreshError: null,
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      startAppUserDeviceAuth: resolved({
        sessionId: "mock-github-device-session",
        userCode: "ADE-MOCK",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: "https://github.com/login/device",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        intervalSec: 5,
      }),
      pollAppUserDeviceAuth: resolved({
        status: "authorized",
        intervalSec: null,
        message: null,
        authStatus: {
          configured: true,
          tokenStored: true,
          userLogin: "arul",
          expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
          credentialState: "authorized",
          refreshBlockedUntil: null,
          lastRefreshError: null,
          checkedAt: new Date().toISOString(),
          error: null,
        },
      }),
      clearAppUserAuth: resolved({
        configured: true,
        tokenStored: false,
        userLogin: null,
        expiresAt: null,
        refreshTokenExpiresAt: null,
        credentialState: "missing",
        refreshBlockedUntil: null,
        lastRefreshError: null,
        checkedAt: new Date().toISOString(),
        error: null,
      }),
      getRequestBudget: resolved({ pausedUntil: null, failureKind: null, retryAt: null }),
      detectRepo: resolved({ owner: "arul28", name: "ADE" }),
      getAppInstallationStatus: resolved({
        repo: { owner: "arul28", name: "ADE" },
        appName: "ADE",
        appSlug: "ade-for-github",
        installUrl: "https://github.com/apps/ade-for-github/installations/new",
        manageUrl: "https://github.com/settings/installations",
        relayConfigured: true,
        installed: true,
        state: "configured",
        installationId: 123,
        repositorySelection: "all",
        lastSeenAt: new Date().toISOString(),
        webhookEvents: ["installation", "installation_repositories", "pull_request"],
        missingWebhookEvents: [],
        webhookState: "active",
        webhookLastSeenAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        error: null,
        appUserAuthFailure: null,
      }),
      listRepoAutolinks: resolved([]),
      createRepoAutolink: resolvedArg({ id: 1, keyPrefix: "ADEPR-", urlTemplate: "https://ade-app.dev/open?type=pr&repo=arul28%2FADE&number=<num>", isAlphanumeric: false }),
      listRepoLabels: resolved([]),
      listRepoCollaborators: resolved([]),
      onStatusChanged: noop,
    },
    prs: {
      createFromLane: resolvedArg(
        USE_ADE_DB_SNAPSHOT ? null : (NORMAL_PRS[0] ?? null),
      ),
      linkToLane: resolvedArg(
        USE_ADE_DB_SNAPSHOT ? null : (NORMAL_PRS[0] ?? null),
      ),
      preflightCreateLaneFromPrBranch: async (args: any) => ({
        preflight: buildCreateLaneFromPrPreflight(args),
        lane: null,
        pr: null,
      }),
      createLaneFromPrBranch: async (args: any) => {
        const preflight = buildCreateLaneFromPrPreflight(args);
        const lane = {
          id: `mock-lane-from-pr-${preflight.githubPrNumber}`,
          name: preflight.targetLaneName,
          laneType: "feature",
          baseRef: preflight.baseBranch ?? "main",
          branchRef: preflight.headBranch,
          worktreePath: `${MOCK_PROJECT.rootPath}/.ade/worktrees/mock-${preflight.githubPrNumber}`,
          attachedRootPath: null,
          isEditProtected: false,
          parentLaneId: null,
          color: null,
          icon: null,
          tags: [],
          folder: null,
          status: {
            dirty: false,
            ahead: 0,
            behind: 0,
            remoteBehind: -1,
            rebaseInProgress: false,
          },
          createdAt: now,
          archivedAt: null,
        };
        const pr =
          ALL_PRS.find(
            (entry: any) =>
              entry.githubPrNumber === preflight.githubPrNumber &&
              entry.repoOwner === preflight.repoOwner &&
              entry.repoName === preflight.repoName,
          ) ??
          ({
            id: `mock-pr-${preflight.githubPrNumber}`,
            laneId: lane.id,
            projectId: MOCK_PROJECT.id,
            repoOwner: preflight.repoOwner,
            repoName: preflight.repoName,
            githubPrNumber: preflight.githubPrNumber,
            githubUrl: preflight.githubUrl,
            githubNodeId: null,
            title: preflight.title,
            state: "open",
            baseBranch: preflight.baseBranch ?? "main",
            headBranch: preflight.headBranch ?? "",
            checksStatus: "none",
            reviewStatus: "none",
            additions: 0,
            deletions: 0,
            lastSyncedAt: now,
            createdAt: now,
            updatedAt: now,
            creationStrategy: "pr_target",
          } as any);
        return { preflight, lane, pr };
      },
      getForLane: async (laneId: string) => {
        const pr = ALL_PRS.find((candidate: any) => candidate.laneId === laneId);
        return pr ? browserMockPrSummaryWithStack(pr) : null;
      },
      listAll: async () => ALL_PRS.map(browserMockPrSummaryWithStack),
      listOpenForRepo: async () =>
        MOCK_GITHUB_SNAPSHOT.repoPullRequests
          .filter((item: any) => item.linkedPrId == null)
          .map((item: any) => ({
            branch: item.headBranch,
            prNumber: item.githubPrNumber,
            title: item.title,
            url: item.githubUrl,
          })),
      refresh: async () => ALL_PRS.map(browserMockPrSummaryWithStack),
      getStatus: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.status ??
        MOCK_STATUS_BY_PR[prId] ?? {
          prId,
          state: "open",
          checksStatus: "passing",
          reviewStatus: "none",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0,
        },
      getChecks: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.checks ??
        MOCK_CHECKS_BY_PR[prId] ??
        [],
      getComments: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.comments ??
        MOCK_COMMENTS_BY_PR[prId] ??
        [],
      getReviews: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.reviews ??
        MOCK_REVIEWS_BY_PR[prId] ??
        [],
      getDetailBundle: async (prId: string) => ({
        status: ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.status ??
          MOCK_STATUS_BY_PR[prId] ?? {
            prId,
            state: "open",
            checksStatus: "passing",
            reviewStatus: "none",
            isMergeable: true,
            mergeConflicts: false,
            behindBaseBy: 0,
          },
        checks: ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.checks ?? MOCK_CHECKS_BY_PR[prId] ?? [],
        reviews: ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.reviews ?? MOCK_REVIEWS_BY_PR[prId] ?? [],
        comments: ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.comments ?? MOCK_COMMENTS_BY_PR[prId] ?? [],
      }),
      getReviewThreads: async (prId: string) => ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.reviewThreads ?? [],
      getDetailByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.detail ?? null,
      getFilesByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.files ?? [],
      getCommitsByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.commits ?? [],
      getActionRunsByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.actionRuns ?? [],
      getActivityByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.activity ?? [],
      getStatusByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.status ?? null,
      getChecksByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.checks ?? [],
      getReviewsByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.reviews ?? [],
      getCommentsByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.comments ?? [],
      getReviewThreadsByGithub: async (args: any) => getAdeDbPrSnapshotByGithubCoordinates(args)?.reviewThreads ?? [],
      updateDescription: resolvedArg(undefined),
      delete: resolvedArg({ deleted: true }),
      draftDescription: resolvedArg({
        title: "AI-drafted title",
        body: "AI-drafted body",
      }),
      land: resolvedArg({ success: true, prNumber: 142, sha: "abc123" }),
      retargetBase: resolvedArg(undefined),
      openInGitHub: resolvedArg(undefined),
      createIntegration: resolvedArg({}),
      simulateIntegration: resolvedArg(MOCK_INTEGRATION_SIMULATION),
      commitIntegration: resolvedArg({
        groupId: "group-int-mock",
        integrationLaneId: "lane-search",
        pr: USE_ADE_DB_SNAPSHOT ? null : (INTEGRATION_PRS[0] ?? null),
        mergeResults: [],
      }),
      getHealth: resolvedArg({}),
      getConflictAnalysis: resolvedArg({}),
      getMergeContext: async (prId: string) =>
        MOCK_MERGE_CONTEXTS[prId] ?? {
          prId,
          groupId: null,
          groupType: null,
          sourceLaneIds: [],
          targetLaneId: null,
          integrationLaneId: null,
          members: [],
        },
      getMergeContexts: async (prIds: string[]) =>
        Object.fromEntries(
          prIds.map((prId) => [
            prId,
            MOCK_MERGE_CONTEXTS[prId] ?? {
              prId,
              groupId: null,
              groupType: null,
              sourceLaneIds: [],
              targetLaneId: null,
              integrationLaneId: null,
              members: [],
            },
          ]),
        ),
      listWithConflicts: resolved(ALL_PRS),
      listSnapshots: async (args?: { prId?: string }) => {
        let snapshots = ADE_DB_PR_SNAPSHOTS;
        const prId = args?.prId?.trim();
        if (prId) {
          snapshots = snapshots.filter((snapshot) => snapshot.prId === prId);
        }
        return snapshots;
      },
      getGitHubSnapshot: resolvedArg(MOCK_GITHUB_SNAPSHOT),
      listGitHubStacks: async () => MOCK_GITHUB_SNAPSHOT.stacks,
      syncGitHubStacks: async () => MOCK_GITHUB_SNAPSHOT.stacks,
      createGitHubStack: async (args: {
        pullRequests: number[];
      }) => {
        const pullRequests = Array.from(new Set(
          (args?.pullRequests ?? []).map(Number).filter((value) => value > 0),
        ));
        const nextNumber = Math.max(
          0,
          ...MOCK_GITHUB_SNAPSHOT.stacks.map((stack: any) => Number(stack.number) || 0),
        ) + 1;
        const stack = {
          id: `mock-stack-${nextNumber}`,
          number: nextNumber,
          nodeId: `MOCK_STACK_${nextNumber}`,
          repoOwner: MOCK_GITHUB_SNAPSHOT.repo?.owner ?? "acme",
          repoName: MOCK_GITHUB_SNAPSHOT.repo?.name ?? "ade",
          baseBranch: "main",
          open: true,
          createdAt: now,
          syncedAt: now,
          lastError: null,
          entries: pullRequests.map((githubPrNumber, index) => {
            const pull = MOCK_GITHUB_SNAPSHOT.repoPullRequests.find(
              (item: any) => item.githubPrNumber === githubPrNumber,
            );
            return {
              githubPrNumber,
              position: index + 1,
              state: pull?.state === "closed" ? "closed" : "open",
              isDraft: Boolean(pull?.isDraft),
              mergedAt: null,
              headBranch: pull?.headBranch ?? `mock/pr-${githubPrNumber}`,
              headSha: `mock-sha-${githubPrNumber}`,
            };
          }),
        };
        MOCK_GITHUB_SNAPSHOT.stacks = [...MOCK_GITHUB_SNAPSHOT.stacks, stack];
        return stack;
      },
      addGitHubStackPullRequests: async (args: {
        stackNumber: number;
        pullRequests: number[];
      }) => {
        const stack = MOCK_GITHUB_SNAPSHOT.stacks.find(
          (candidate: any) => candidate.number === Number(args?.stackNumber),
        );
        if (!stack) throw new Error(`Unknown GitHub stack: ${args?.stackNumber}`);
        const known = new Set(
          stack.entries.map((entry: any) => Number(entry.githubPrNumber)),
        );
        for (const githubPrNumber of args?.pullRequests ?? []) {
          const normalizedNumber = Number(githubPrNumber);
          if (!Number.isInteger(normalizedNumber) || normalizedNumber <= 0 || known.has(normalizedNumber)) {
            continue;
          }
          known.add(normalizedNumber);
          const pull = MOCK_GITHUB_SNAPSHOT.repoPullRequests.find(
            (item: any) => item.githubPrNumber === normalizedNumber,
          );
          stack.entries.push({
            githubPrNumber: normalizedNumber,
            position: stack.entries.length + 1,
            state: pull?.state === "closed" ? "closed" : "open",
            isDraft: Boolean(pull?.isDraft),
            mergedAt: null,
            headBranch: pull?.headBranch ?? `mock/pr-${normalizedNumber}`,
            headSha: `mock-sha-${normalizedNumber}`,
          });
        }
        stack.syncedAt = now;
        return stack;
      },
      unstackGitHubStack: async (args: { stackNumber: number }) => {
        const index = MOCK_GITHUB_SNAPSHOT.stacks.findIndex(
          (candidate: any) => candidate.number === Number(args?.stackNumber),
        );
        if (index < 0) return null;
        const [stack] = MOCK_GITHUB_SNAPSHOT.stacks.splice(index, 1);
        return stack ?? null;
      },
      listIntegrationWorkflows: resolved(MOCK_INTEGRATION_WORKFLOWS),
      aiResolutionStart: async () => ({
        sessionId: "mock-pr-ai-session",
        provider: "codex" as const,
        ptyId: null,
        status: "started" as const,
        error: null,
        context: { sourceTab: "normal" as const, laneId: "lane-1" },
      }),
      aiResolutionInput: resolvedArg(undefined),
      aiResolutionStop: resolvedArg(undefined),
      onAiResolutionEvent: noop,
      onEvent: noop,
      getDetail: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.detail ?? {
          prId,
          body: null,
          labels: [],
          assignees: [],
          requestedReviewers: [],
          author: { login: "", avatarUrl: null },
          isDraft: false,
          milestone: null,
          linkedIssues: [],
        },
      getFiles: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.files ?? MOCK_LIVE_PR_FILES[prId] ?? [],
      getCommits: async (prId: string) =>
        ADE_DB_PR_SNAPSHOT_BY_ID.get(prId)?.commits ?? [],
      getDeployments: resolvedArg([]),
      getAiSummary: resolvedArg(null),
      regenerateAiSummary: resolvedArg(null),
      postReviewComment: resolvedArg({
        id: "mock-review-comment",
        author: "you",
        body: "",
        url: null,
        createdAt: now,
        updatedAt: now,
      }),
      setReviewThreadResolved: resolvedArg(undefined),
      reactToComment: resolvedArg(undefined),
      cleanupBranch: resolvedArg({ deleted: false, reason: "browser-mock" }),
      aiResolutionGetSession: resolvedArg(null),
      getActionRuns: resolvedArg([]),
      getActivity: resolvedArg([]),
      addComment: resolvedArg({
        id: "mock",
        author: "you",
        body: "",
        source: "issue",
        url: null,
        path: null,
        line: null,
        createdAt: null,
        updatedAt: null,
      }),
      replyToReviewThread: resolvedArg({
        id: "thread-reply",
        author: "you",
        authorAvatarUrl: null,
        body: "",
        url: null,
        createdAt: null,
        updatedAt: null,
      }),
      resolveReviewThread: resolvedArg(undefined),
      updateTitle: resolvedArg(undefined),
      updateBody: resolvedArg(undefined),
      setLabels: resolvedArg(undefined),
      requestReviewers: resolvedArg(undefined),
      submitReview: resolvedArg({
        id: "pr-review-1",
        nodeId: "PRR_mock_1",
        htmlUrl: "https://github.com/mock/repo/pull/1#pullrequestreview-1",
        state: "COMMENTED",
        submittedAt: now,
      }),
      close: resolvedArg(undefined),
      reopen: resolvedArg(undefined),
      setDraft: resolvedArg(undefined),
      setAutoMerge: resolvedArg(undefined),
      rerunChecks: resolvedArg(undefined),
      aiReviewSummary: resolvedArg({
        summary: "AI review summary placeholder",
        potentialIssues: [],
        recommendations: [],
        mergeReadiness: "ready",
      }),
      listProposals: resolved([]),
      dismissIntegrationCleanup: resolvedArg(
        USE_ADE_DB_SNAPSHOT
          ? undefined
          : (BUILTIN_MOCK_INTEGRATION_WORKFLOWS[1] ?? undefined),
      ),
      cleanupIntegrationWorkflow: resolvedArg({
        proposalId: "workflow-int-active",
        archivedLaneIds: ["lane-search"],
        skippedLaneIds: [],
        workflowDisplayState: "history",
        cleanupState: "completed",
      }),
      updateProposal: resolvedArg(undefined),
      deleteProposal: resolvedArg(undefined),
      createIntegrationLaneForProposal: resolvedArg({
        integrationLaneId: "lane-search",
        mergedCleanLanes: [],
        conflictingLanes: [],
      }),
      startIntegrationResolution: resolvedArg({}),
      getIntegrationResolutionState: resolvedArg(null),
      recheckIntegrationStep: resolvedArg({}),
    },
    rebase: {
      scanNeeds: resolved(MOCK_REBASE_NEEDS),
      getNeed: resolvedArg(null),
      dismiss: resolvedArg(undefined),
      defer: resolvedArg2(undefined),
      execute: resolvedArg({}),
      onEvent: noop,
    },
    history: {
      listOperations: async (args: any = {}) => {
        let rows = ADE_DB_OPERATIONS;
        if (typeof args?.laneId === "string" && args.laneId.trim()) {
          rows = rows.filter(
            (operation) => operation.laneId === args.laneId.trim(),
          );
        }
        if (typeof args?.kind === "string" && args.kind.trim()) {
          rows = rows.filter(
            (operation) => operation.kind === args.kind.trim(),
          );
        }
        if (typeof args?.status === "string" && args.status !== "all") {
          rows = rows.filter((operation) => operation.status === args.status);
        }
        const limit = Number.isFinite(args?.limit)
          ? Math.max(1, Math.floor(args.limit))
          : rows.length;
        return rows.slice(0, limit);
      },
      exportOperations: async (args: any = {}) => ({
        operations: await (window as any).ade.history.listOperations(args),
      }),
    },
    layout: {
      get: resolvedArg(null),
      set: resolvedArg2(undefined),
    },
    tilingTree: {
      get: resolvedArg(null),
      set: resolvedArg2(undefined),
    },
    tests: {
      listSuites: resolved([]),
      run: resolvedArg({}),
      stop: resolvedArg(undefined),
      listRuns: resolved([]),
      getLogTail: resolvedArg(""),
      onEvent: noop,
    },
    projectConfig: {
      get: resolved(BROWSER_MOCK_PROJECT_CONFIG_SNAPSHOT),
      validate: resolvedArg({ ok: true, issues: [] as any[] }),
      save: resolvedArg(BROWSER_MOCK_PROJECT_CONFIG_SNAPSHOT),
      diffAgainstDisk: resolved({ changed: false } as any),
    },
    adeCli: {
      getStatus: resolved({
        command: "ade",
        platform: "darwin",
        isPackaged: false,
        bundledAvailable: true,
        bundledBinDir: "/tmp/mock/ADE/apps/ade-cli/bin",
        bundledCommandPath: "/tmp/mock/ADE/apps/ade-cli/bin/ade",
        installerPath: null,
        agentPathReady: true,
        terminalInstalled: false,
        terminalCommandPath: null,
        installAvailable: false,
        installTargetPath: "~/.local/bin/ade",
        installTargetDirOnPath: false,
        message:
          "ADE-launched agents can use ade. Terminal access is not installed yet.",
        nextAction: "Run npm link in apps/ade-cli for local development.",
      }),
      installForUser: resolved({
        ok: false,
        message: "Terminal install is available from packaged ADE builds.",
        status: {
          command: "ade",
          platform: "darwin",
          isPackaged: false,
          bundledAvailable: true,
          bundledBinDir: "/tmp/mock/ADE/apps/ade-cli/bin",
          bundledCommandPath: "/tmp/mock/ADE/apps/ade-cli/bin/ade",
          installerPath: null,
          agentPathReady: true,
          terminalInstalled: false,
          terminalCommandPath: null,
          installAvailable: false,
          installTargetPath: "~/.local/bin/ade",
          installTargetDirOnPath: false,
          message:
            "ADE-launched agents can use ade. Terminal access is not installed yet.",
          nextAction: "Run npm link in apps/ade-cli for local development.",
        },
      }),
    },
    zoom: {
      getLevel: () => mockZoomLevel,
      setLevel: (level: number) => {
        mockZoomLevel = level;
        if (!vitestRuntime) applyHostedWebZoom(zoomFactorForLevel(level));
      },
      getFactor: () => zoomFactorForLevel(mockZoomLevel),
      setTitleBarOverlay: async () => ({ applied: false }),
      onCommand: () => () => {},
    },
    updateCheckForUpdates: resolved(undefined),
    updateGetState: resolved({
      status: "idle",
      currentVersion: "0.0.0",
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
    }),
    keepAwakeGet: resolved(MOCK_KEEP_AWAKE_SNAPSHOT),
    keepAwakeSetLevel: async (): Promise<KeepAwakeSnapshot> => MOCK_KEEP_AWAKE_SNAPSHOT,
    keepAwakeFixSystemSleep: resolved({
      ok: false,
      error: "Not available in the browser preview.",
      snapshot: MOCK_KEEP_AWAKE_SNAPSHOT,
    }),
    updateGetPreferences: resolved({ ...DEFAULT_AUTO_UPDATE_PREFERENCES }),
    updateSetPreferences: async (
      preferences: AutoUpdatePreferences,
    ): Promise<AutoUpdatePreferences> => preferences,
    updateGetInstallImpact: resolved({ connectedPhones: [] }),
    updateQuitAndInstall: resolved(true),
    updateCancelAutoApply: resolved(false),
    updateDismissInstalledNotice: resolved(undefined),
    onUpdateEvent: noop,
  };
  void attachBrowserRuntimeBridge();
} // window
