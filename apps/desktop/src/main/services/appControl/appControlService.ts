import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { appControlProofCaption } from "../../../shared/proofProvenance";
import { WebSocket, type RawData } from "ws";
import type {
  AppControlAgentClearArgs,
  AppControlAgentClickArgs,
  AppControlAgentFillArgs,
  AppControlAgentHoverArgs,
  AppControlAgentPressArgs,
  AppControlAgentScrollArgs,
  AppControlAgentTypeArgs,
  AppControlAgentWaitArgs,
  AppControlAttachToTargetArgs,
  AppControlCaptureProofArgs,
  AppControlCaptureProofResult,
  AppControlClaimArgs,
  AppControlClickArgs,
  AppControlConnectArgs,
  AppControlConsoleDiagnostic,
  AppControlContextItem,
  AppControlCoordinateSpace,
  AppControlDispatchKeyArgs,
  AppControlDriver,
  AppControlDriverCapability,
  AppControlDriversResult,
  AppControlElement,
  AppControlEventPayload,
  AppControlFrame,
  AppControlInspectPointArgs,
  AppControlInspectResult,
  AppControlLaunchArgs,
  AppControlNetworkDiagnostic,
  AppControlObservationArgs,
  AppControlRecordStartArgs,
  AppControlRecordStopArgs,
  AppControlRecordingStatus,
  AppControlRecordingStatusArgs,
  AppControlScreencastFrame,
  AppControlScreenshot,
  AppControlScrollArgs,
  AppControlSelectResult,
  AppControlSession,
  AppControlSessionTargetArgs,
  AppControlSnapshot,
  AppControlSnapshotArgs,
  AppControlSourceMatch,
  AppControlStatus,
  AppControlStopArgs,
  AppControlSwitchWindowArgs,
  AppControlTarget,
  AppControlTraceArgs,
  AppControlTypeTextArgs,
  AppControlWindowsResult,
  WindowsShellKind,
} from "../../../shared/types";
import {
} from "../../../shared/agentObservation";
import {
  MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS,
  MAX_APP_CONTROL_NETWORK_DIAGNOSTICS,
  isRecord,
  normalizePositiveInteger,
  optionalFiniteNumber,
  stringOrNull,
} from "./appControlObservations";
import { createAppControlAgentActions } from "./appControlAgentActions";
import {
  APP_CONTROL_PROOF_BACKEND_NAME,
  createAppControlRecording,
  type AppControlScreencastRecorderBackend,
  type AppControlWindowRecorder,
} from "./appControlRecording";
import { createAppControlWindowRecorder } from "./appControlWindowRecorder";
import type {
  ComputerUseArtifactIngestionRequest,
  ComputerUseArtifactIngestionResult,
  ComputerUseArtifactOwner,
} from "../../../shared/types/computerUseArtifacts";
import { killWindowsProcessTreeAsync } from "../shared/processExecution";
import type { Logger } from "../logging/logger";
import type { createPtyService } from "../pty/ptyService";
import { imageDimensions } from "../shared/imageDimensions";
import {
  commandForwardsAppControlDebug,
  commandLooksLikeDirectElectronLaunch,
  commandLooksLikePackageScriptLaunch,
  insertDebugFlagsIntoDirectElectronCommand,
  resolveDirectElectronLaunch,
  resolvePackageScriptElectronLaunch,
  rewritePackageScriptElectronLaunch,
  shellQuote,
  unquoteShellValue,
} from "./appControlLaunchCommand";

const CDP_POLL_MS = 500;
const CDP_HEALTH_POLL_MS = 2_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;
const MAX_DOM_ELEMENTS = 450;
const SOURCE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".css"]);
const SOURCE_SKIP_DIRS = new Set([".git", ".ade", "node_modules", "dist", "build", "out", "coverage", ".next", ".vite"]);
const SOURCE_FILE_CACHE_MAX = 200;
const MAX_PENDING_NETWORK_REQUESTS = 500;

function cleanClaimId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

type CreateAppControlServiceArgs = {
  projectRoot: string;
  logger: Logger;
  ptyService?: ReturnType<typeof createPtyService> | null;
  resolveLaneId?: (args: {
    projectRoot: string;
    cwd: string;
    laneId?: string | null;
    chatSessionId?: string | null;
  }) => Promise<string | null> | string | null;
  /**
   * The lane a chat belongs to, or null. Used for calls that name a chat and
   * no lane. When absent, `resolveLaneId` is asked with the chat id instead.
   */
  resolveChatLaneId?: ((chatSessionId: string) => Promise<string | null> | string | null) | null;
  onEvent?: ((payload: AppControlEventPayload) => void) | null;
  /**
   * macOS recording engine. Defaults to a private `ade-desktop-driver` that is
   * spawned on the first recording. Pass null to turn window recording off.
   */
  windowRecorder?: AppControlWindowRecorder | null;
  /**
   * Windows/Linux recording engine: the MediaRecorder host in the ADE desktop
   * app on this machine. Read at each start; null means no desktop app here,
   * and a start is refused with "needs the ADE desktop app".
   */
  getScreencastRecorder?: (() => AppControlScreencastRecorderBackend | null) | null;
  /** Files a captioned recording as proof (the artifact broker's `ingest`). */
  ingestArtifacts?: ((request: ComputerUseArtifactIngestionRequest) =>
    Promise<ComputerUseArtifactIngestionResult> | ComputerUseArtifactIngestionResult) | null;
  /** The lane's primary pull request URL; it becomes a `github_pr` proof owner. */
  resolvePrimaryPrUrl?: ((laneId: string) => Promise<string | null> | string | null) | null;
  /** The lane's name, for the caption of a recording that filed itself. */
  resolveLaneName?: ((laneId: string) => Promise<string | null> | string | null) | null;
};

/** How a call names its lane: directly, by the session it holds, or by its chat. */
type AppControlLaneRef = {
  laneId?: string | null;
  chatSessionId?: string | null;
  sessionId?: string | null;
};

/** An event as a lane controller emits it; the controller adds its `laneId`. */
type LaneEventPayload = AppControlEventPayload extends infer P
  ? P extends { laneId: unknown } ? Omit<P, "laneId"> : never
  : never;

type CdpTarget = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type CdpScreenshotResponse = {
  data: string;
};

type CdpRuntimeEvaluateResponse<T> = {
  result?: {
    type?: string;
    value?: T;
    description?: string;
  };
  exceptionDetails?: unknown;
};

type CdpDomGetNodeForLocationResponse = {
  backendNodeId?: number;
  frameId?: string;
  nodeId?: number;
};

type CdpDomResolveNodeResponse = {
  object?: {
    objectId?: string;
  };
};

type CdpRuntimeCallFunctionOnResponse<T> = {
  result?: {
    type?: string;
    value?: T;
    description?: string;
  };
  exceptionDetails?: unknown;
};

type CdpInputPageState = {
  hasFocus: boolean;
  visibilityState: string;
};

type CdpDomClickResult = {
  ok: boolean;
  target: string | null;
  label: string | null;
};

type CdpPendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type DomSnapshotPayload = {
  url: string | null;
  title: string | null;
  viewport: { width: number; height: number; devicePixelRatio: number };
  elements: Array<{
    tagName: string | null;
    role: string | null;
    label: string | null;
    value: string | null;
    selector: string | null;
    testId: string | null;
    rect: AppControlFrame;
    metadata: Record<string, unknown>;
  }>;
};

type PointViewport = {
  x: number;
  y: number;
};

type ResolvedLaunch = {
  label: string;
  cwd: string;
  commandForDisplay: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  windowsStartupCommands?: Partial<Record<WindowsShellKind, string>>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundFrame(frame: AppControlFrame): AppControlFrame {
  return {
    x: round(frame.x),
    y: round(frame.y),
    width: round(frame.width),
    height: round(frame.height),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asPositiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function normalizeProjectRoot(projectRoot: string | null | undefined, fallback: string): string {
  const raw = projectRoot?.trim();
  return path.resolve(raw?.length ? raw : fallback);
}

function normalizeCwd(cwd: string | null | undefined, projectRoot: string): string {
  const raw = cwd?.trim();
  if (!raw?.length) return path.resolve(projectRoot);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
}

function ensureCwdInsideRoot(cwd: string, projectRoot: string): void {
  const root = path.resolve(projectRoot);
  if (cwd === root || cwd.startsWith(`${root}${path.sep}`)) return;
  throw new Error(
    `App Control launch must run inside the current lane. cwd ${cwd} is outside ${root}.`,
  );
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Could not allocate an App Control debug port."));
      });
    });
  });
}

function httpGetJson<T>(url: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Timed out reading ${url}`));
    });
    req.on("error", reject);
  });
}

async function listCdpTargets(port: number): Promise<CdpTarget[]> {
  const targets = await httpGetJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`);
  return Array.isArray(targets) ? targets : [];
}

function pickCdpTarget(targets: CdpTarget[]): CdpTarget | null {
  const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return (
    pageTargets.find((target) => {
      const title = `${target.title ?? ""} ${target.url ?? ""}`.toLowerCase();
      return !title.includes("devtools") && !title.includes("developer tools");
    })
    ?? pageTargets[0]
    ?? targets.find((target) => Boolean(target.webSocketDebuggerUrl))
    ?? null
  );
}

class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, CdpPendingCommand>();
  private readonly methodListeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;
  private readonly closeWaiters = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: RawData) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const method = typeof message.method === "string" ? message.method : null;
      if (method) {
        const listeners = this.methodListeners.get(method);
        if (listeners) {
          for (const listener of listeners) {
            try { listener(message.params); } catch { /* ignore */ }
          }
        }
        return;
      }
      const id = typeof message.id === "number" ? message.id : null;
      if (id == null) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error && typeof message.error === "object") {
        const error = message.error as { message?: string };
        pending.reject(new Error(error.message ?? "CDP command failed."));
      } else {
        pending.resolve(message.result);
      }
    });
    ws.on("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed."));
      }
      this.pending.clear();
      for (const resolve of this.closeWaiters) resolve();
      this.closeWaiters.clear();
    });
    ws.on("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.pending.clear();
    });
  }

  static connect(wsUrl: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once("open", () => resolve(new CdpClient(ws)));
      ws.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms.`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.ws.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    let listeners = this.methodListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.methodListeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.methodListeners.get(method);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.methodListeners.delete(method);
    };
  }

  isClosed(): boolean {
    return this.closed || this.ws.readyState === this.ws.CLOSING || this.ws.readyState === this.ws.CLOSED;
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.ws.readyState === this.ws.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.closeWaiters.add(resolve);
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close();
      } else if (this.ws.readyState === this.ws.CLOSING) {
        // Already waiting for the close event.
      } else {
        this.ws.terminate();
      }
    });
  }
}

function cdpDomSnapshotScript(maxElements: number): string {
  return `(() => {
    const roleFor = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "input") return el.type === "checkbox" ? "checkbox" : "textbox";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (/^h[1-6]$/.test(tag)) return "heading";
      return null;
    };
    const textFor = (el) => {
      const aria = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
      const text = (aria || el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      return text.slice(0, 180) || null;
    };
    const selectorFor = (el) => {
      if (el.id) return "#" + CSS.escape(el.id);
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
      if (testId) return "[data-testid='" + String(testId).replace(/'/g, "\\\\'") + "']";
      const parts = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        const classes = Array.from(current.classList || []).filter((value) => !/[:\\[\\]\\/]/.test(value)).slice(0, 2);
        if (classes.length) part += "." + classes.map((value) => CSS.escape(value)).join(".");
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.length ? parts.join(" > ") : null;
    };
    const viewport = { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 };
    const all = Array.from(document.querySelectorAll("body *"));
    const scored = [];
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 2 || rect.height < 2) continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.left > viewport.width || rect.top > viewport.height) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity || "1") < 0.05) continue;
      const label = textFor(el);
      const role = roleFor(el);
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa") || null;
      const interactive = Boolean(role || testId || el.matches("button,a,input,textarea,select,[tabindex],[contenteditable='true'],[onclick]"));
      const score = (interactive ? 10000 : 0) + (label ? 1000 : 0) - Math.min(rect.width * rect.height, 500000) / 1000;
      scored.push({ el, rect, label, role, testId, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      url: location.href || null,
      title: document.title || null,
      viewport,
      elements: scored.slice(0, ${maxElements}).map(({ el, rect, label, role, testId }) => ({
        tagName: el.tagName.toLowerCase(),
        role,
        label,
        value: "value" in el && typeof el.value === "string" ? el.value.slice(0, 180) : null,
        selector: selectorFor(el),
        testId,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        metadata: {
          id: el.id || null,
          className: typeof el.className === "string" ? el.className.slice(0, 240) : null,
          ariaLabel: el.getAttribute("aria-label"),
          name: el.getAttribute("name"),
          href: el.getAttribute("href"),
          type: el.getAttribute("type")
        }
      }))
    };
  })()`;
}

function cdpPointSnapshotScript(point: PointViewport): string {
  const pointJson = JSON.stringify({
    x: point.x,
    y: point.y,
  });
  return `(() => {
    const point = ${pointJson};
    const roleFor = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "input") return el.type === "checkbox" ? "checkbox" : "textbox";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (/^h[1-6]$/.test(tag)) return "heading";
      return null;
    };
    const textFor = (el) => {
      const aria = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
      const text = (aria || el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      return text.slice(0, 180) || null;
    };
    const selectorFor = (el) => {
      if (el.id) return "#" + CSS.escape(el.id);
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
      if (testId) return "[data-testid='" + String(testId).replace(/'/g, "\\\\'") + "']";
      const parts = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        const classes = Array.from(current.classList || []).filter((value) => !/[:\\[\\]\\/]/.test(value)).slice(0, 2);
        if (classes.length) part += "." + classes.map((value) => CSS.escape(value)).join(".");
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.length ? parts.join(" > ") : null;
    };
    const viewport = { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 };
    const cssX = point.x;
    const cssY = point.y;
    const seen = new Set();
    const candidates = [];
    const isElement = (value) => value && value.nodeType === Node.ELEMENT_NODE;
    const isInteractive = (el) => Boolean(roleFor(el) || el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa") || el.matches("button,a,input,textarea,select,[tabindex],[contenteditable='true'],[onclick]"));
    const add = (el) => {
      if (!isElement(el) || seen.has(el)) return;
      seen.add(el);
      if (el === document.body || el === document.documentElement) return;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
      if (rect.bottom < 0 || rect.right < 0 || rect.left > viewport.width || rect.top > viewport.height) return;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity || "1") < 0.05) return;
      const role = roleFor(el);
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa") || null;
      const interactive = isInteractive(el);
      const area = rect.width * rect.height;
      const label = interactive || area < 50000 ? textFor(el) : null;
      const score = (interactive ? 10000 : 0) + (testId ? 4000 : 0) + (role ? 2000 : 0) + (label ? 500 : 0) - Math.min(area, 500000) / 1000;
      candidates.push({ el, rect, label, role, testId, score });
    };
    const stack = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(cssX, cssY)
      : [document.elementFromPoint(cssX, cssY)].filter(Boolean);
    for (const raw of stack) {
      add(raw);
      let current = raw?.parentElement ?? null;
      while (current && current !== document.body) {
        if (isInteractive(current)) {
          add(current);
          break;
        }
        current = current.parentElement;
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return {
      url: location.href || null,
      title: document.title || null,
      viewport,
      elements: candidates.slice(0, 20).map(({ el, rect, label, role, testId }) => ({
        tagName: el.tagName.toLowerCase(),
        role,
        label,
        value: "value" in el && typeof el.value === "string" ? el.value.slice(0, 180) : null,
        selector: selectorFor(el),
        testId,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        metadata: {
          id: el.id || null,
          className: typeof el.className === "string" ? el.className.slice(0, 240) : null,
          ariaLabel: el.getAttribute("aria-label"),
          name: el.getAttribute("name"),
          href: el.getAttribute("href"),
          type: el.getAttribute("type")
        }
      }))
    };
  })()`;
}

const CDP_NODE_METADATA_FUNCTION = String.raw`
function() {
  const roleFor = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "input") return el.type === "checkbox" ? "checkbox" : "textbox";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return null;
  };
  const escapeIdent = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const quoteAttr = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const selectorFor = (node) => {
    if (!node) return null;
    const testId = node.getAttribute("data-testid")
      || node.getAttribute("data-test")
      || node.getAttribute("data-test-id")
      || node.getAttribute("data-qa")
      || node.getAttribute("data-cy");
    if (node.id) return "#" + escapeIdent(node.id);
    if (testId) return node.tagName.toLowerCase() + "[data-testid=\"" + quoteAttr(testId) + "\"]";
    const parts = [];
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList || []).filter((value) => !/[:\\[\\]\\/]/.test(value)).slice(0, 2);
      if (classes.length) part += "." + classes.map((value) => escapeIdent(value)).join(".");
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.length ? parts.join(" > ") : null;
  };
  const textFor = (el) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const aria = el.getAttribute("aria-label") || labelledByText || el.getAttribute("alt") || el.getAttribute("title") || "";
    const text = (aria || el.innerText || el.textContent || el.getAttribute("name") || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 180) || null;
  };
  const isInteractive = (el) => Boolean(
    roleFor(el)
    || el.getAttribute("data-testid")
    || el.getAttribute("data-test")
    || el.getAttribute("data-test-id")
    || el.getAttribute("data-qa")
    || el.getAttribute("data-cy")
    || el.matches("button,a,input,textarea,select,summary,[tabindex],[contenteditable='true'],[onclick]")
  );
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") >= 0.05;
  };
  const pickElement = (raw) => {
    let element = raw && raw.nodeType === Node.ELEMENT_NODE
      ? raw
      : raw && raw.parentElement
        ? raw.parentElement
        : null;
    if (!element) return null;
    const stack = [];
    let current = element;
    while (current && current !== document.body && current !== document.documentElement) {
      stack.push(current);
      current = current.parentElement;
    }
    const interactive = stack.find((candidate) => isInteractive(candidate) && visible(candidate));
    if (interactive) return interactive;
    const labelled = stack.find((candidate) => textFor(candidate) && visible(candidate));
    return labelled || (visible(element) ? element : null);
  };
  const element = pickElement(this);
  const viewport = { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 };
  if (!element) {
    return {
      url: location.href || null,
      title: document.title || null,
      viewport,
      elements: []
    };
  }
  const rect = element.getBoundingClientRect();
  const tagName = element.tagName ? element.tagName.toLowerCase() : null;
  const role = roleFor(element);
  const testId = element.getAttribute("data-testid")
    || element.getAttribute("data-test")
    || element.getAttribute("data-test-id")
    || element.getAttribute("data-qa")
    || element.getAttribute("data-cy")
    || null;
  const isPasswordInput = element.tagName === "INPUT"
    && typeof element.type === "string"
    && element.type.toLowerCase() === "password";
  return {
    url: location.href || null,
    title: document.title || null,
    viewport,
    elements: [{
      tagName,
      role,
      label: textFor(element),
      value: isPasswordInput ? null : ("value" in element && typeof element.value === "string" ? element.value.slice(0, 180) : null),
      selector: selectorFor(element),
      testId,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      metadata: {
        id: element.id || null,
        className: typeof element.className === "string" ? element.className.slice(0, 240) : null,
        ariaLabel: element.getAttribute("aria-label"),
        name: element.getAttribute("name"),
        href: element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href"),
        type: element.getAttribute("type"),
        disabled: "disabled" in element ? Boolean(element.disabled) : null,
        checked: "checked" in element ? Boolean(element.checked) : null
      }
    }]
  };
}
`;

function cdpDomClickScript(point: { x: number; y: number }): string {
  const pointJson = JSON.stringify({
    x: point.x,
    y: point.y,
  });
  return `(() => {
    const point = ${pointJson};
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, target: null, label: null };
    const originalTarget = document.elementFromPoint(x, y);
    if (!originalTarget) return { ok: false, target: null, label: null };
    const target = originalTarget instanceof Element ? originalTarget : originalTarget.parentElement;
    if (!target) return { ok: false, target: null, label: null };
    const eventTarget = target.closest("button,a,input,textarea,select,[role='button'],[role='menuitem'],[tabindex],[contenteditable='true']") || target;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      view: window
    };
    const dispatchMouse = (type, buttons, detail = 0) => {
      eventTarget.dispatchEvent(new MouseEvent(type, { ...base, buttons, detail }));
    };
    const dispatchPointer = (type, buttons) => {
      if (typeof PointerEvent !== "function") return;
      eventTarget.dispatchEvent(new PointerEvent(type, {
        ...base,
        buttons,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      }));
    };
    if (typeof eventTarget.focus === "function") {
      try { eventTarget.focus({ preventScroll: true }); } catch { try { eventTarget.focus(); } catch {} }
    }
    dispatchPointer("pointerover", 0);
    dispatchMouse("mouseover", 0);
    dispatchPointer("pointermove", 0);
    dispatchMouse("mousemove", 0);
    dispatchPointer("pointerdown", 1);
    dispatchMouse("mousedown", 1);
    dispatchPointer("pointerup", 0);
    dispatchMouse("mouseup", 0);
    dispatchMouse("click", 0, 1);
    const label = (
      eventTarget.getAttribute?.("aria-label")
      || eventTarget.getAttribute?.("title")
      || eventTarget.textContent
      || ""
    ).replace(/\\s+/g, " ").trim().slice(0, 120) || null;
    return {
      ok: true,
      target: eventTarget.tagName ? eventTarget.tagName.toLowerCase() : null,
      label
    };
  })()`;
}

function collectSourceFiles(root: string, cache: Map<string, string[]>): string[] {
  const cached = cache.get(root);
  if (cached) {
    // LRU touch: re-insert to mark as most recently used.
    cache.delete(root);
    cache.set(root, cached);
    return cached;
  }
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name)) visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name))) continue;
      out.push(fullPath);
      if (out.length >= 5_000) return;
    }
  };
  visit(root);
  cache.set(root, out);
  // Bounded LRU eviction: drop oldest entries when over capacity.
  while (cache.size > SOURCE_FILE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return out;
}

function readSourceSnippet(projectRoot: string, sourceFile: string | null, sourceLine: number | null): string | null {
  if (!sourceFile || !sourceLine) return null;
  const fullPath = path.resolve(projectRoot, sourceFile);
  if (!fullPath.startsWith(path.resolve(projectRoot) + path.sep) && fullPath !== path.resolve(projectRoot)) return null;
  let text: string;
  try {
    text = fs.readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, sourceLine - 4);
  const end = Math.min(lines.length, sourceLine + 3);
  return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n");
}

function sourceTermsForElement(element: AppControlElement): Array<{ term: string; reason: string; confidence: AppControlSourceMatch["confidence"] }> {
  const raw: Array<{ value: string | null | undefined; reason: string; confidence: AppControlSourceMatch["confidence"] }> = [
    { value: element.testId, reason: "data-testid", confidence: "exact" },
    { value: element.label, reason: "visible text", confidence: "candidate" },
    { value: element.value, reason: "input value", confidence: "candidate" },
    { value: element.role, reason: "ARIA role", confidence: "candidate" },
  ];
  const seen = new Set<string>();
  const out: Array<{ term: string; reason: string; confidence: AppControlSourceMatch["confidence"] }> = [];
  for (const item of raw) {
    const normalized = item.value?.trim();
    if (!normalized || normalized.length < 2) continue;
    const candidates = [
      normalized,
      ...normalized.split(/\s+[·•|]\s+|[,;:]/).map((part) => part.trim()).filter((part) => part.length >= 3),
    ];
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ term: candidate, reason: item.reason, confidence: item.confidence });
    }
  }
  const selector = element.selector ?? "";
  const classCandidates = selector.match(/\.[A-Za-z0-9_-]{3,}/g)?.map((value) => value.slice(1)) ?? [];
  for (const className of classCandidates.slice(0, 3)) {
    const key = className.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term: className, reason: "CSS class", confidence: "candidate" });
  }
  return out;
}

function findSourceMatches(
  projectRoot: string | null | undefined,
  element: AppControlElement,
  cache: Map<string, string[]>,
  options: { maxMs?: number; includeCandidates?: boolean } = {},
): AppControlSourceMatch[] {
  if (!projectRoot) return [];
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root)) return [];
  const startedAt = Date.now();
  const maxMs = options.maxMs ?? 350;
  const terms = sourceTermsForElement(element)
    .filter((term) => options.includeCandidates !== false || term.confidence === "exact");
  if (!terms.length) return [];
  const matches: AppControlSourceMatch[] = [];
  for (const filePath of collectSourceFiles(root, cache)) {
    if (Date.now() - startedAt > maxMs) break;
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    for (const term of terms) {
      const index = lower.indexOf(term.term.toLowerCase());
      if (index < 0) continue;
      const sourceLine = text.slice(0, index).split(/\r?\n/).length;
      const sourceFile = path.relative(root, filePath);
      matches.push({
        sourceFile,
        sourceLine,
        confidence: term.confidence,
        reason: `${term.reason} matched ${JSON.stringify(term.term)}`,
        snippet: readSourceSnippet(root, sourceFile, sourceLine),
      });
    }
  }
  const score = (match: AppControlSourceMatch): number => {
    let value = match.confidence === "exact" ? 100 : 40;
    if (/data-testid/.test(match.reason)) value += 50;
    if (/\.(tsx|jsx)$/.test(match.sourceFile)) value += 20;
    if (/src|app|components|renderer/.test(match.sourceFile)) value += 10;
    return value;
  };
  const deduped = new Map<string, AppControlSourceMatch>();
  for (const match of matches) {
    const key = `${match.sourceFile}:${match.sourceLine}:${match.reason}`;
    if (!deduped.has(key)) deduped.set(key, match);
  }
  return Array.from(deduped.values())
    .sort((a, b) => score(b) - score(a) || a.sourceFile.localeCompare(b.sourceFile) || a.sourceLine - b.sourceLine)
    .slice(0, 5);
}

function compactElement(element: AppControlElement | null): Record<string, unknown> | null {
  if (!element) return null;
  return {
    ref: element.ref,
    provider: element.provider,
    tagName: element.tagName,
    role: element.role,
    label: element.label,
    value: element.value,
    selector: element.selector,
    testId: element.testId,
    screenshotFrame: element.pixelFrame,
  };
}

function nearbyElements(snapshot: AppControlSnapshot, selected: AppControlElement): Array<Record<string, unknown>> {
  const centerX = selected.pixelFrame.x + selected.pixelFrame.width / 2;
  const centerY = selected.pixelFrame.y + selected.pixelFrame.height / 2;
  return snapshot.elements
    .filter((element) => element.id !== selected.id)
    .map((element) => {
      const otherX = element.pixelFrame.x + element.pixelFrame.width / 2;
      const otherY = element.pixelFrame.y + element.pixelFrame.height / 2;
      return {
        distance: Math.hypot(otherX - centerX, otherY - centerY),
        element,
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8)
    .map(({ element }) => compactElement(element) ?? {});
}

function findSmallestElementAt(elements: AppControlElement[], x: number, y: number): AppControlElement | null {
  return elements
    .filter((element) => {
      const frame = element.pixelFrame;
      return x >= frame.x && y >= frame.y && x <= frame.x + frame.width && y <= frame.y + frame.height;
    })
    .sort((a, b) => {
      const score = (element: AppControlElement): number => {
        const tag = element.tagName ?? "";
        return (
          (element.testId ? 4000 : 0)
          + (element.role ? 2000 : 0)
          + (/^(button|a|input|textarea|select)$/.test(tag) ? 1000 : 0)
          + (element.label ? 100 : 0)
          - Math.min(element.pixelFrame.width * element.pixelFrame.height, 500000) / 1000
        );
      };
      return score(b) - score(a) || (a.pixelFrame.width * a.pixelFrame.height) - (b.pixelFrame.width * b.pixelFrame.height);
    })[0] ?? null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The pid of the app's Electron main process: the one that owns its windows.
 *
 * The launch terminal's pid is the shell (or npm), never Electron. CDP's
 * browser target reports the browser process directly; the process listening
 * on the debug port is the same process, and is the fallback when a target
 * refuses `SystemInfo`.
 */
async function readAppProcessId(port: number): Promise<number | null> {
  try {
    const version = await httpGetJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
    if (version?.webSocketDebuggerUrl) {
      const client = await withTimeout(CdpClient.connect(version.webSocketDebuggerUrl), 2_000, "CDP browser connect");
      try {
        const info = await withTimeout(
          client.send<{ processInfo?: Array<{ type?: string; id?: number }> }>("SystemInfo.getProcessInfo"),
          3_000,
          "SystemInfo.getProcessInfo",
        );
        const browser = info.processInfo?.find((entry) =>
          entry.type === "browser" && typeof entry.id === "number" && Number.isInteger(entry.id) && entry.id > 0);
        if (browser?.id && browser.id !== process.pid) return browser.id;
      } finally {
        void client.close();
      }
    }
  } catch {
    // Fall through to the port owner.
  }
  return await readListeningProcessId(port);
}

function readListeningProcessId(port: number): Promise<number | null> {
  // Only the macOS window recording needs the pid, and the stop fallback is a
  // best effort; Windows has no `lsof`.
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 3_000, windowsHide: true },
      (error, stdout) => {
        if (error && !stdout) {
          resolve(null);
          return;
        }
        const pid = String(stdout ?? "")
          .split(/\s+/)
          .map((value) => Number(value))
          .find((value) => Number.isInteger(value) && value > 1 && value !== process.pid);
        resolve(pid ?? null);
      },
    );
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: it exists but belongs to another user, so it is not
    // the app ADE launched. Either way there is nothing for ADE to kill.
    return false;
  }
}

/**
 * Kills an app ADE launched, with its children, when its launcher's tree kill
 * missed it (a launcher that detached it, or one that exited first).
 * Windows goes through the canonical `taskkill /T /F`; POSIX sends SIGTERM and
 * then SIGKILL after the grace.
 */
async function killProcessTreeIfAlive(
  pid: number,
  options: { force: boolean; graceMs: number; logger: Logger },
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  await delay(options.graceMs);
  if (!processIsAlive(pid)) return;
  options.logger.info("app_control.stop_kill_app_process", { pid, force: options.force });
  if (process.platform === "win32") {
    await killWindowsProcessTreeAsync(pid, (detail) => {
      options.logger.debug("app_control.stop_taskkill_failed", { pid, status: detail.status });
    });
    return;
  }
  try {
    process.kill(pid, options.force ? "SIGKILL" : "SIGTERM");
  } catch {
    return;
  }
  if (options.force) return;
  await delay(1_500);
  if (!processIsAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone between the check and the kill.
  }
}

// ---------------------------------------------------------------------
// Driver capability gate
//
// `cdp` is the only implemented driver. `computer_use` is typed and listed
// so callers can discover it, but selecting it fails with a typed error
// instead of silently falling back to CDP.
// ---------------------------------------------------------------------
// Both facts, in one sentence: the driver does not exist in this build on any
// platform, and even when it does it will be macOS-only. Saying only the
// second told a Windows user the feature works if they switch to a Mac — it
// does not; on macOS the same driver reports "not implemented".
const COMPUTER_USE_PLATFORM_REASON =
  "The computer-use App Control driver is not implemented in this build; native app control would be macOS only.";
const COMPUTER_USE_UNIMPLEMENTED_REASON =
  "The computer-use App Control driver is not implemented in this build.";

const computerUseCapability = (): AppControlDriverCapability => (
  process.platform === "darwin"
    ? { driver: "computer_use", status: "unavailable", reason: COMPUTER_USE_UNIMPLEMENTED_REASON, implemented: false }
    : { driver: "computer_use", status: "unavailable", reason: COMPUTER_USE_PLATFORM_REASON, implemented: false }
);

const listDriversFor = (activeSession: AppControlSession | null): AppControlDriversResult => ({
  platform: process.platform,
  activeDriver: activeSession?.driver ?? null,
  drivers: [
    {
      driver: "cdp",
      status: "available",
      reason: null,
      implemented: true,
    },
    computerUseCapability(),
  ],
});

const normalizeDriver = (value: AppControlDriver | null | undefined): AppControlDriver => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw === "cdp") return "cdp";
  if (raw === "computer_use" || raw === "computer-use") return "computer_use";
  throw new Error(`Unknown App Control driver '${raw}'. Supported drivers: cdp, computer_use.`);
};

const requireSupportedDriver = (value: AppControlDriver | null | undefined): AppControlDriver => {
  const driver = normalizeDriver(value);
  if (driver === "cdp") return driver;
  const capability = computerUseCapability();
  throw new Error(`App Control driver 'computer_use' is unavailable: ${capability.reason}`);
};

const providersFor = (activeSession: AppControlSession | null): AppControlStatus["providers"] => {
  const waitingForCdp = activeSession
    && (activeSession.status === "starting" || activeSession.status === "running")
    && activeSession.cdpPort
    && !activeSession.cdpEndpoint;
  const cdpDetail = activeSession?.cdpEndpoint
    ?? (waitingForCdp && activeSession?.cdpPort
      ? `Waiting for CDP on 127.0.0.1:${activeSession.cdpPort}. ADE forwards debug flags for common package-script and Electron launches; if this stays blank, quit old app instances or wire ADE_APP_CONTROL_DEBUG_FLAGS into the launcher.`
      : "Launch Electron with --remote-debugging-port or connect to an existing CDP port.");
  return [
    {
      provider: "cdp",
      available: Boolean(activeSession?.cdpPort && activeSession.status === "connected"),
      detail: cdpDetail,
    },
    {
      provider: "computer-use",
      // Proof (screenshots and recordings) works on every platform; macOS adds
      // window capture and OS-level input.
      available: true,
      detail: process.platform === "darwin"
        ? "Proof: screenshots and window recordings. macOS OS-level input can complement CDP."
        : "Proof: screenshots and screencast recordings through CDP.",
    },
  ];
};

export type AppControlService = ReturnType<typeof createAppControlService>;

export function createAppControlService(args: CreateAppControlServiceArgs) {
  // Bounded LRU cache scoped to this service instance — dies with the service,
  // so rebuilding the project naturally invalidates stale paths. Capped to
  // SOURCE_FILE_CACHE_MAX entries to keep growth bounded.
  const sourceFileCache = new Map<string, string[]>();
  /** laneId → that lane's session machinery. One service per project, one session per lane. */
  const controllers = new Map<string, LaneController>();
  /** The newest selection on any lane, for callers that do not name one. */
  let lastSelectedItemAnyLane: AppControlContextItem | null = null;

  const recording = createAppControlRecording({
    logger: args.logger,
    projectRoot: args.projectRoot,
    emit: (payload) => args.onEvent?.(payload),
    getSession: (laneId) => controllers.get(laneId)?.getSession() ?? null,
    getLastFrame: (laneId) => controllers.get(laneId)?.getLastFrame() ?? null,
    resolveAppProcessId: async (laneId) => await controllers.get(laneId)?.resolveAppProcessId() ?? null,
    resolveTargetTitle: async (laneId) => await controllers.get(laneId)?.getTargetTitle() ?? null,
    windowRecorder: args.windowRecorder !== undefined
      ? args.windowRecorder
      : createAppControlWindowRecorder({ logger: args.logger }),
    screencastRecorder: () => args.getScreencastRecorder?.() ?? null,
    ingestArtifacts: args.ingestArtifacts ?? null,
    resolvePrimaryPrUrl: args.resolvePrimaryPrUrl ?? null,
    resolveLaneName: args.resolveLaneName ?? null,
  });

  /**
   * One lane's App Control session and everything that hangs off it: the CDP
   * pollers, the screencast socket, the diagnostics tallies and the agent
   * trace. The service keeps one of these per lane.
   */
  function createLaneController(laneId: string) {
    let activeSession: AppControlSession | null = null;
    let lastSelectedItem: AppControlContextItem | null = null;
    let cdpPollTimer: NodeJS.Timeout | null = null;
    let cdpHealthTimer: NodeJS.Timeout | null = null;
    let cdpAttachmentEpoch = 0;
    let screencastClient: CdpClient | null = null;
    let screencastSessionId: string | null = null;
    let screencastTargetId: string | null = null;
    let screencastEndpoint: string | null = null;
    let screencastGeneration = 0;
    let lastScreencastFrame: AppControlScreencastFrame | null = null;
    // Agent-observation state. Diagnostics ride along on the persistent
    // screencast client so `observe` can report console errors, failed requests,
    // and in-flight request count without opening another socket per call.
    let consoleDiagnostics: AppControlConsoleDiagnostic[] = [];
    let networkDiagnostics: AppControlNetworkDiagnostic[] = [];
    const pendingNetworkRequests = new Map<string, { url: string; method: string | null; resourceType: string | null; startedAt: string; startedAtMs: number }>();
    let lastNetworkActivityAtMs = Date.now();
    // Trace before/after context. The controlled app has no tab bar to read, so
    // observations and waits keep the last known document identity here.

    /**
     * Error tallies since the app's last navigation or reattach — the number the
     * Work tools pane's red dot reports. Kept as counters rather than derived
     * from the diagnostic buffers, which are capped rolling windows: an app that
     * logs 200 errors would otherwise report only the last 50.
     */
    let consoleErrorCount = 0;
    let failedRequestCount = 0;

    const resetDiagnostics = (): void => {
      consoleDiagnostics = [];
      networkDiagnostics = [];
      pendingNetworkRequests.clear();
      lastNetworkActivityAtMs = Date.now();
      if (consoleErrorCount === 0 && failedRequestCount === 0) return;
      consoleErrorCount = 0;
      failedRequestCount = 0;
      // A reset is a state transition, not a storm: publish it now, and cancel
      // any coalesced emit so the old tally cannot land after the zero.
      forceEmitDiagnostics();
    };

    const emit = (payload: LaneEventPayload) => {
      const full = { ...payload, laneId } as AppControlEventPayload;
      if (full.type === "frame") recording.noteFrame(laneId, full.frame);
      args.onEvent?.(full);
    };

    /**
     * Publishes the session's error tally. Emitted on change only, and only from
     * the paths that can move it, so nothing has to poll `observe` to find out
     * whether the app under control is broken.
     *
     * Coalesced on a trailing edge because the target of App Control is by
     * construction an app under active debugging: a render loop calling
     * `console.error` produced one IPC event per error, fanned out to every
     * subscribed window and CLI listener, to move the same red dot. 250 ms
     * matches the debounce the Work-tools state service already uses for this
     * class of signal. `flushDiagnostics` exists for the paths that must publish
     * now (a reset, a teardown).
     */
    const DIAGNOSTICS_COALESCE_MS = 250;
    let diagnosticsTimer: ReturnType<typeof setTimeout> | null = null;

    const publishDiagnostics = (): void => {
      const sessionId = activeSession?.id;
      if (!sessionId) return;
      emit({
        type: "diagnostics",
        sessionId,
        consoleErrorCount,
        failedRequestCount,
        updatedAt: nowIso(),
      });
    };

    /** Publish immediately, cancelling any coalesced emit. */
    const forceEmitDiagnostics = (): void => {
      if (diagnosticsTimer) {
        clearTimeout(diagnosticsTimer);
        diagnosticsTimer = null;
      }
      publishDiagnostics();
    };

    /** Publish a coalesced emit that is still pending, if there is one. */
    const flushDiagnostics = (): void => {
      if (!diagnosticsTimer) return;
      forceEmitDiagnostics();
    };

    const emitDiagnostics = (): void => {
      if (diagnosticsTimer) return;
      diagnosticsTimer = setTimeout(() => {
        diagnosticsTimer = null;
        publishDiagnostics();
      }, DIAGNOSTICS_COALESCE_MS);
      diagnosticsTimer.unref?.();
    };

    const updateSession = (patch: Partial<AppControlSession>) => {
      if (!activeSession) return null;
      const previousStatus = activeSession.status;
      activeSession = { ...activeSession, ...patch };
      emit({ type: "session-updated", session: activeSession });
      // The app went away (quit, crash, lost target): a recording of it stops
      // and files what it has. An explicit stop handles its own recording.
      const nextStatus = activeSession.status;
      if (
        nextStatus !== previousStatus
        && (nextStatus === "exited" || nextStatus === "failed" || nextStatus === "stopped"
          || (previousStatus === "connected" && nextStatus === "running"))
      ) {
        void recording.stopForAppClosed(laneId);
      }
      return activeSession;
    };

    const stopCdpPoller = () => {
      if (cdpPollTimer) {
        clearTimeout(cdpPollTimer);
        cdpPollTimer = null;
      }
    };

    const stopCdpHealthCheck = () => {
      if (cdpHealthTimer) {
        clearTimeout(cdpHealthTimer);
        cdpHealthTimer = null;
      }
    };

    const closeScreencastClient = async (client: CdpClient | null): Promise<void> => {
      if (!client) return;
      await client.send("Page.stopScreencast").catch(() => {});
      await Promise.race([
        client.close(),
        delay(750),
      ]);
    };

    const stopScreencast = async () => {
      screencastGeneration += 1;
      const client = screencastClient;
      screencastClient = null;
      screencastSessionId = null;
      screencastTargetId = null;
      screencastEndpoint = null;
      // Drop the cached frame so a subsequent getSnapshot doesn't return a stale
      // image from the previous target after the user switches windows or the
      // app exits.
      lastScreencastFrame = null;
      resetDiagnostics();
      await closeScreencastClient(client);
    };

    const pushConsoleDiagnostic = (entry: AppControlConsoleDiagnostic): void => {
      consoleDiagnostics = [...consoleDiagnostics, entry].slice(-MAX_APP_CONTROL_CONSOLE_DIAGNOSTICS);
      if (entry.level === "error") {
        consoleErrorCount += 1;
        emitDiagnostics();
      }
    };

    const pushNetworkDiagnostic = (entry: AppControlNetworkDiagnostic): void => {
      networkDiagnostics = [...networkDiagnostics, entry].slice(-MAX_APP_CONTROL_NETWORK_DIAGNOSTICS);
      // A transport failure and a 4xx/5xx both read as "this app is broken" to
      // the person glancing at the tools pane; a 200 does not.
      if (entry.error != null || (entry.statusCode != null && entry.statusCode >= 400)) {
        failedRequestCount += 1;
        emitDiagnostics();
      }
    };

    const consoleLevelFor = (value: unknown): AppControlConsoleDiagnostic["level"] => {
      const raw = typeof value === "string" ? value.toLowerCase() : "";
      if (raw === "error" || raw === "assert") return "error";
      if (raw === "warning" || raw === "warn") return "warning";
      if (raw === "debug" || raw === "verbose") return "debug";
      return "info";
    };

    /**
     * Console + network capture for `observe`. Registered on the long-lived
     * screencast client so observations carry the same diagnostics the built-in
     * browser reports, and so a failed fetch is visible to the agent even when
     * the UI looks unchanged.
     */
    const subscribeDiagnostics = (client: CdpClient): void => {
      client.on("Runtime.consoleAPICalled", (params) => {
        if (!isRecord(params)) return;
        const argsList = Array.isArray(params.args) ? params.args : [];
        const message = argsList
          .map((entry) => {
            if (!isRecord(entry)) return "";
            if (typeof entry.value === "string") return entry.value;
            if (entry.value !== undefined) return JSON.stringify(entry.value);
            return stringOrNull(entry.description) ?? "";
          })
          .filter(Boolean)
          .join(" ")
          .slice(0, 2_000);
        if (!message) return;
        pushConsoleDiagnostic({
          level: consoleLevelFor(params.type),
          message,
          sourceId: null,
          line: null,
          column: null,
          timestamp: nowIso(),
        });
      });
      client.on("Log.entryAdded", (params) => {
        const entry = isRecord(params) && isRecord(params.entry) ? params.entry : null;
        if (!entry) return;
        const message = stringOrNull(entry.text);
        if (!message) return;
        pushConsoleDiagnostic({
          level: consoleLevelFor(entry.level),
          message: message.slice(0, 2_000),
          sourceId: stringOrNull(entry.url),
          line: normalizePositiveInteger(entry.lineNumber),
          column: null,
          timestamp: nowIso(),
        });
      });
      client.on("Network.requestWillBeSent", (params) => {
        if (!isRecord(params)) return;
        const requestId = stringOrNull(params.requestId);
        const request = isRecord(params.request) ? params.request : {};
        const url = stringOrNull(request.url);
        if (!requestId || !url) return;
        lastNetworkActivityAtMs = Date.now();
        // A long-lived app can start requests that never emit a finished/failed
        // event (streams, aborted sockets). Bound the map so `pendingRequestCount`
        // stays meaningful and the session cannot leak entries.
        if (pendingNetworkRequests.size >= MAX_PENDING_NETWORK_REQUESTS) {
          const oldest = pendingNetworkRequests.keys().next();
          if (!oldest.done) pendingNetworkRequests.delete(oldest.value);
        }
        pendingNetworkRequests.set(requestId, {
          url,
          method: stringOrNull(request.method),
          resourceType: stringOrNull(params.type),
          startedAt: nowIso(),
          startedAtMs: Date.now(),
        });
      });
      const settleRequest = (requestId: string | null): { url: string; method: string | null; resourceType: string | null; startedAt: string; startedAtMs: number } | null => {
        lastNetworkActivityAtMs = Date.now();
        if (!requestId) return null;
        const pending = pendingNetworkRequests.get(requestId) ?? null;
        pendingNetworkRequests.delete(requestId);
        return pending;
      };
      client.on("Network.responseReceived", (params) => {
        if (!isRecord(params)) return;
        const response = isRecord(params.response) ? params.response : {};
        const statusCode = optionalFiniteNumber(response.status);
        if (statusCode == null || statusCode < 400) {
          lastNetworkActivityAtMs = Date.now();
          return;
        }
        const requestId = stringOrNull(params.requestId);
        const pending = requestId ? pendingNetworkRequests.get(requestId) ?? null : null;
        pushNetworkDiagnostic({
          url: stringOrNull(response.url) ?? pending?.url ?? "about:blank",
          method: pending?.method ?? null,
          resourceType: stringOrNull(params.type) ?? pending?.resourceType ?? null,
          statusCode,
          error: null,
          startedAt: pending?.startedAt ?? null,
          endedAt: nowIso(),
          durationMs: pending ? Math.max(0, Date.now() - pending.startedAtMs) : null,
        });
      });
      client.on("Network.loadingFinished", (params) => {
        settleRequest(isRecord(params) ? stringOrNull(params.requestId) : null);
      });
      client.on("Network.loadingFailed", (params) => {
        if (!isRecord(params)) return;
        const pending = settleRequest(stringOrNull(params.requestId));
        if (params.canceled === true) return;
        pushNetworkDiagnostic({
          url: pending?.url ?? "about:blank",
          method: pending?.method ?? null,
          resourceType: stringOrNull(params.type) ?? pending?.resourceType ?? null,
          statusCode: null,
          error: stringOrNull(params.errorText) ?? "Request failed.",
          startedAt: pending?.startedAt ?? null,
          endedAt: nowIso(),
          durationMs: pending ? Math.max(0, Date.now() - pending.startedAtMs) : null,
        });
      });
      client.on("Page.frameNavigated", (params) => {
        // Main frame only: an iframe swapping documents is not a new page, and
        // zeroing the tally on one would hide errors the app just logged.
        const frame = isRecord(params) && isRecord(params.frame) ? params.frame : null;
        if (!frame || stringOrNull(frame.parentId)) return;
        resetDiagnostics();
      });
      // Best-effort: a target that refuses one of these still streams frames and
      // serves input, it just reports fewer diagnostics.
      void client.send("Runtime.enable").catch(() => {});
      void client.send("Log.enable").catch(() => {});
      void client.send("Network.enable").catch(() => {});
    };

    const startScreencast = async (sessionId: string, targetId: string | null, cdpEndpoint: string): Promise<void> => {
      if (
        screencastClient
        && screencastSessionId === sessionId
        && screencastTargetId === targetId
        && screencastEndpoint === cdpEndpoint
        && !screencastClient.isClosed()
      ) {
        return;
      }
      const generation = screencastGeneration + 1;
      screencastGeneration = generation;
      const previousClient = screencastClient;
      screencastClient = null;
      screencastSessionId = null;
      screencastTargetId = null;
      screencastEndpoint = null;
      lastScreencastFrame = null;
      await closeScreencastClient(previousClient);
      let client: CdpClient;
      try {
        client = await CdpClient.connect(cdpEndpoint);
      } catch (error) {
        args.logger.debug?.("app_control.screencast_connect_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (
        screencastGeneration !== generation
        || !activeSession
        || activeSession.id !== sessionId
        || activeSession.cdpTargetId !== targetId
        || activeSession.cdpEndpoint !== cdpEndpoint
      ) {
        await client.close();
        return;
      }
      screencastClient = client;
      screencastSessionId = sessionId;
      screencastTargetId = targetId;
      screencastEndpoint = cdpEndpoint;
      resetDiagnostics();
      subscribeDiagnostics(client);
      try {
        await client.send("Page.enable");
      } catch {
        // continue — startScreencast will fail loudly if it really isn't ready
      }
      client.on("Page.screencastFrame", (params) => {
        if (
          screencastGeneration !== generation
          || screencastClient !== client
          || screencastSessionId !== sessionId
          || screencastTargetId !== targetId
          || activeSession?.id !== sessionId
          || activeSession.cdpTargetId !== targetId
        ) {
          return;
        }
        if (!params || typeof params !== "object") return;
        const record = params as {
          data?: string;
          sessionId?: number;
          metadata?: { offsetTop?: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number; scrollOffsetX?: number; scrollOffsetY?: number; timestamp?: number };
        };
        const data = typeof record.data === "string" ? record.data : "";
        if (!data) return;
        const meta = record.metadata ?? {};
        const buffer = Buffer.from(data, "base64");
        const encodedDimensions = imageDimensions(buffer);
        const viewportWidth = typeof meta.deviceWidth === "number" && meta.deviceWidth > 0
          ? meta.deviceWidth
          : encodedDimensions?.width ?? 0;
        const viewportHeight = typeof meta.deviceHeight === "number" && meta.deviceHeight > 0
          ? meta.deviceHeight
          : encodedDimensions?.height ?? 0;
        const bitmapWidth = encodedDimensions?.width ?? viewportWidth;
        const bitmapHeight = encodedDimensions?.height ?? viewportHeight;
        const scaleX = viewportWidth > 0 && bitmapWidth > 0 ? bitmapWidth / viewportWidth : 1;
        const scaleY = viewportHeight > 0 && bitmapHeight > 0 ? bitmapHeight / viewportHeight : scaleX;
        const devicePixelRatio = typeof meta.pageScaleFactor === "number" && meta.pageScaleFactor > 0
          ? meta.pageScaleFactor
          : scaleX || 1;
        const frame: AppControlScreencastFrame = {
          sessionId,
          laneId,
          cdpTargetId: targetId,
          data,
          mimeType: "image/jpeg",
          width: bitmapWidth,
          height: bitmapHeight,
          scale: scaleX || 1,
          viewportWidth,
          viewportHeight,
          devicePixelRatio,
          scaleX,
          scaleY,
          capturedAt: typeof meta.timestamp === "number"
            ? new Date(meta.timestamp * 1000).toISOString()
            : nowIso(),
        };
        lastScreencastFrame = frame;
        emit({ type: "frame", frame });
        const ack = typeof record.sessionId === "number" ? record.sessionId : null;
        if (ack != null) {
          client.send("Page.screencastFrameAck", { sessionId: ack }).catch(() => {});
        }
      });
      try {
        await client.send("Page.startScreencast", {
          format: "jpeg",
          // 78 is the empirical sweet spot for JPEG over CDP — visibly clean text
          // without ballooning per-frame payload (which would re-introduce lag
          // through the IPC + base64 hop).
          quality: 78,
          maxWidth: 1600,
          maxHeight: 1000,
          everyNthFrame: 1,
        });
      } catch (error) {
        args.logger.debug?.("app_control.screencast_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (screencastGeneration === generation) await stopScreencast();
      }
    };

    const startCdpPoller = (sessionId: string, port: number) => {
      stopCdpPoller();
      const poll = async () => {
        cdpPollTimer = null;
        if (!activeSession || activeSession.id !== sessionId) return;
        if (activeSession.status === "connected" || activeSession.status === "stopping" || activeSession.status === "stopped") return;
        const pollEpoch = cdpAttachmentEpoch;
        const desiredTargetId = activeSession.cdpTargetId;
        try {
          const targets = await listCdpTargets(port);
          if (!activeSession || activeSession.id !== sessionId || cdpAttachmentEpoch !== pollEpoch) return;
          const stickyTarget = desiredTargetId
            ? targets.find((candidate) => candidate.id === desiredTargetId && candidate.webSocketDebuggerUrl)
            : null;
          const target = stickyTarget ?? pickCdpTarget(targets);
          if (target?.webSocketDebuggerUrl) {
            updateSession({
              cdpEndpoint: target.webSocketDebuggerUrl,
              cdpTargetId: target.id,
              connectedAt: nowIso(),
              status: "connected",
              lastError: null,
            });
            startCdpHealthCheck(sessionId, port);
            void startScreencast(sessionId, target.id, target.webSocketDebuggerUrl).catch(() => {});
            return;
          }
        } catch {
          // The app may not have opened its CDP renderer yet. Keep observing.
        }
        if (activeSession?.id === sessionId) {
          cdpPollTimer = setTimeout(() => void poll(), CDP_POLL_MS);
        }
      };
      cdpPollTimer = setTimeout(() => void poll(), CDP_POLL_MS);
    };

    // Once we're connected, keep watching the CDP target list so a quit app
    // (Cmd+Q while the launch terminal stays alive, or a crash) flips the
    // session back to "running"/"failed" instead of leaving the panel showing
    // a stale "Connected" state.
    const startCdpHealthCheck = (sessionId: string, port: number) => {
      stopCdpHealthCheck();
      const poll = async () => {
        cdpHealthTimer = null;
        if (!activeSession || activeSession.id !== sessionId) return;
        if (activeSession.status === "stopping" || activeSession.status === "stopped" || activeSession.status === "exited" || activeSession.status === "failed") return;
        const pollEpoch = cdpAttachmentEpoch;
        const pollTargetId = activeSession.cdpTargetId;
        let target: CdpTarget | null = null;
        let listError: Error | null = null;
        try {
          const targets = await listCdpTargets(port);
          if (!activeSession || activeSession.id !== sessionId || cdpAttachmentEpoch !== pollEpoch || activeSession.cdpTargetId !== pollTargetId) {
            return;
          }
          // CRITICAL: prefer the user's currently-attached target if it's still
          // listed. Falling back to pickCdpTarget on every health tick would
          // silently re-attach to whatever target shows up first in /json/list,
          // overwriting the user's window choice every 2 seconds.
          const stickyTarget = activeSession.cdpTargetId
            ? targets.find((candidate) => candidate.id === activeSession?.cdpTargetId && candidate.webSocketDebuggerUrl)
            : null;
          target = stickyTarget ?? pickCdpTarget(targets);
        } catch (error) {
          listError = error instanceof Error ? error : new Error(String(error));
        }
        if (!activeSession || activeSession.id !== sessionId || cdpAttachmentEpoch !== pollEpoch || activeSession.cdpTargetId !== pollTargetId) {
          return;
        }
        if (target?.webSocketDebuggerUrl) {
          if (activeSession.status !== "connected" || activeSession.cdpEndpoint !== target.webSocketDebuggerUrl) {
            updateSession({
              cdpEndpoint: target.webSocketDebuggerUrl,
              cdpTargetId: target.id,
              connectedAt: activeSession.connectedAt ?? nowIso(),
              status: "connected",
              lastError: null,
            });
          }
        } else if (activeSession.status === "connected") {
          // Target vanished after being connected — the controlled app is gone
          // even if the launch terminal's shell is still alive (Ctrl+C in
          // npm-style scripts leaves the shell running). Mark the session as
          // exited so the UI hides Stop and surfaces relaunch as the next step.
          // We keep a poller running so a fresh launch from the same shell
          // reconnects us automatically.
          const terminalAlive = Boolean(activeSession.terminalSessionId);
          updateSession({
            cdpEndpoint: null,
            cdpTargetId: activeSession.cdpTargetId,
            status: terminalAlive ? "running" : "exited",
            lastError: listError ? listError.message : "App Control lost the CDP target. The app may have quit.",
          });
          if (terminalAlive) startCdpPoller(sessionId, port);
          return;
        }
        if (activeSession?.id !== sessionId) return;
        const stillTracking = activeSession.status === "connected" || activeSession.status === "running" || activeSession.status === "starting";
        if (!stillTracking) return;
        cdpHealthTimer = setTimeout(() => void poll(), CDP_HEALTH_POLL_MS);
      };
      cdpHealthTimer = setTimeout(() => void poll(), CDP_HEALTH_POLL_MS);
    };

    const unsubscribePtyExit = args.ptyService?.onExit((event) => {
      if (!activeSession?.terminalSessionId || event.sessionId !== activeSession.terminalSessionId) return;
      stopCdpPoller();
      stopCdpHealthCheck();
      updateSession({
        status: activeSession.status === "stopping"
          ? "stopped"
          : event.exitCode === 0
            ? "exited"
            : "failed",
        lastError: event.exitCode === 0 ? null : `Terminal exited with code ${event.exitCode ?? "unknown"}.`,
      });
    }) ?? null;

    /** Hands the lane's session to a chat. A session never changes lanes. */
    const claim = (claimArgs: AppControlClaimArgs = {}): AppControlSession | null => {
      if (!activeSession) return null;
      const chatSessionId = cleanClaimId(claimArgs.chatSessionId);
      if (!chatSessionId) return activeSession;
      activeSession = { ...activeSession, chatSessionId };
      emit({ type: "session-updated", session: activeSession });
      return activeSession;
    };

    const resolveLaunch = (launchArgs: AppControlLaunchArgs, debugPort: number): ResolvedLaunch => {
      const projectRoot = normalizeProjectRoot(launchArgs.projectRoot, args.projectRoot);
      const debugFlags = [
        `--remote-debugging-port=${debugPort}`,
        "--remote-debugging-address=127.0.0.1",
      ];
      const autoDebugFlags = [
        `--remote-debugging-port=${debugPort}`,
      ];

      if (launchArgs.command?.trim()) {
        const cwd = normalizeCwd(launchArgs.cwd, projectRoot);
        ensureCwdInsideRoot(cwd, projectRoot);
        const rawCommand = launchArgs.command.trim();
        // Reject commands that try to step outside the lane via `cd <other path>`.
        // App Control source-matches against the lane root, so running an app
        // from a sibling repo would surface unrelated source matches.
        const cdMatches = Array.from(rawCommand.matchAll(/(?:^|[;&|]\s*)cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))\s*&&/g));
        for (const match of cdMatches) {
          const target = match[1] ? unquoteShellValue(match[1]) : "";
          if (!target) continue;
          const resolvedTarget = path.resolve(cwd, target);
          const laneRoot = path.resolve(projectRoot);
          if (resolvedTarget !== laneRoot && !resolvedTarget.startsWith(`${laneRoot}${path.sep}`)) {
            throw new Error(
              `App Control launch must run inside the current lane. The command tried to \`cd\` to ${resolvedTarget}, which is outside ${laneRoot}. Run the app from this lane instead.`,
            );
          }
        }
        let command = rawCommand;
        let windowsStartupCommands: Partial<Record<WindowsShellKind, string>> | undefined;
        if (!commandForwardsAppControlDebug(command)) {
          if (process.platform === "win32") {
            const structuredPackage = resolvePackageScriptElectronLaunch(
              command,
              autoDebugFlags,
              cwd,
              { platform: process.platform },
            );
            if (structuredPackage) {
              return {
                label: launchArgs.label?.trim() || rawCommand,
                cwd: structuredPackage.cwd,
                command: structuredPackage.command,
                args: structuredPackage.args,
                env: structuredPackage.env,
                commandForDisplay: structuredPackage.commandForDisplay,
              };
            }
            const structuredDirect = resolveDirectElectronLaunch(
              command,
              autoDebugFlags,
              { platform: process.platform },
            );
            if (structuredDirect) {
              return {
                label: launchArgs.label?.trim() || rawCommand,
                cwd,
                command: structuredDirect.command,
                args: structuredDirect.args,
                env: structuredDirect.env,
                commandForDisplay: structuredDirect.commandForDisplay,
              };
            }
          }

          if (commandLooksLikePackageScriptLaunch(command)) {
            if (process.platform === "win32") {
              const originalCommand = command;
              windowsStartupCommands = Object.fromEntries(
                (["powershell", "cmd", "git-bash"] as const)
                  .map((shell) => [
                    shell,
                    rewritePackageScriptElectronLaunch(originalCommand, autoDebugFlags, cwd, {
                      platform: "win32",
                      shell,
                    }),
                  ] as const)
                  .filter((entry): entry is readonly [WindowsShellKind, string] => Boolean(entry[1])),
              ) as Partial<Record<WindowsShellKind, string>>;
              command = windowsStartupCommands.powershell
                ?? `${originalCommand} -- ${autoDebugFlags.map(shellQuote).join(" ")}`;
            } else {
              command = rewritePackageScriptElectronLaunch(command, autoDebugFlags, cwd, {
                platform: process.platform,
              }) ?? `${command} -- ${autoDebugFlags.map(shellQuote).join(" ")}`;
            }
          } else if (commandLooksLikeDirectElectronLaunch(command)) {
            command = insertDebugFlagsIntoDirectElectronCommand(command, autoDebugFlags);
          }
        }
        if (command.includes("{ADE_APP_CONTROL_DEBUG_FLAGS}")) {
          command = command.replace(/\{ADE_APP_CONTROL_DEBUG_FLAGS\}/g, debugFlags.map(shellQuote).join(" "));
        }
        return {
          label: launchArgs.label?.trim() || rawCommand,
          cwd,
          commandForDisplay: command,
          ...(windowsStartupCommands && Object.keys(windowsStartupCommands).length
            ? { windowsStartupCommands }
            : {}),
        };
      }

      throw new Error("App Control launch requires a command.");
    };

    /** The Electron main process of the attached app, keyed by session and endpoint. */
    let appPidCache: { key: string; pid: number } | null = null;
    const resolveAppProcessId = async (): Promise<number | null> => {
      const session = activeSession;
      if (!session?.cdpPort) return null;
      const key = `${session.id}:${session.cdpEndpoint ?? ""}`;
      if (appPidCache?.key === key) return appPidCache.pid;
      const pid = await readAppProcessId(session.cdpPort);
      if (pid && activeSession?.id === session.id) appPidCache = { key, pid };
      return pid;
    };

    /**
     * Stops the lane's session.
     *
     * An app ADE launched is quit, whole process tree: Ctrl+C to the launch
     * terminal, then a tree kill through the terminal service (taskkill /T on
     * Windows), then the Electron main process itself if it outlived its
     * launcher. An app ADE attached to is only detached; it keeps running.
     * A running recording is stopped first, and filed when it has a caption.
     */
    const stop = async (stopArgs: AppControlStopArgs = {}): Promise<{ ok: true; previousSession: AppControlSession | null }> => {
      const previousSession = activeSession;
      if (previousSession && recording.isRecording(laneId)) {
        await recording.stopRecording(laneId, cleanClaimId(stopArgs.chatSessionId)).catch((error: unknown) => {
          args.logger.debug("app_control.stop_recording_failed", {
            laneId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      // Read while the app still answers CDP; it is the fallback kill target.
      const launchedAppPid = previousSession?.terminalSessionId
        ? await resolveAppProcessId().catch(() => null)
        : null;
      cdpAttachmentEpoch += 1;
      stopCdpPoller();
      stopCdpHealthCheck();
      lastSelectedItem = null;
      if (previousSession) {
        activeSession = { ...previousSession, status: "stopping", lastError: null };
        emit({ type: "session-updated", session: activeSession });
      }
      const terminalSessionId = previousSession?.terminalSessionId ?? null;
      if (terminalSessionId && args.ptyService) {
        try {
          args.ptyService.signalTerminal({ terminalId: terminalSessionId, signal: stopArgs.force ? "SIGKILL" : "SIGINT" });
          if (!stopArgs.force) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            const currentSession = activeSession;
            if (currentSession && currentSession.id === previousSession?.id && currentSession.status === "stopping") {
              args.ptyService.signalTerminal({ terminalId: terminalSessionId, signal: "SIGTERM" });
            }
          }
        } catch (error) {
          args.logger.debug("app_control.stop_failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (launchedAppPid) {
        await killProcessTreeIfAlive(launchedAppPid, {
          force: stopArgs.force === true,
          graceMs: stopArgs.force ? 250 : 1_000,
          logger: args.logger,
        });
      }
      appPidCache = null;
      await stopScreencast();
      // For terminal-backed sessions, keep state as "stopping" — the PTY onExit
      // callback will publish the final "stopped"/"exited"/"failed" state when
      // the process actually exits. For non-terminal sessions, finalize now.
      const finalSession = previousSession
        ? terminalSessionId
          ? (activeSession ?? { ...previousSession, status: "stopping" as const })
          : { ...(activeSession ?? previousSession), status: "stopped" as const }
        : null;
      activeSession = finalSession;
      if (activeSession) emit({ type: "session-updated", session: activeSession });
      emit({ type: "session-stopped", previousSession });
      return { ok: true, previousSession: finalSession };
    };

    const connect = async (connectArgs: AppControlConnectArgs): Promise<AppControlSession> => {
      requireSupportedDriver(connectArgs.driver);
      const replaceableSession = activeSession && ["exited", "failed", "stopped"].includes(activeSession.status);
      if (activeSession && !replaceableSession && !connectArgs.force) {
        throw new Error("App Control already has an active session on this lane. Pass force=true to replace it.");
      }
      if (activeSession) await stop({ force: true });
      const projectRoot = normalizeProjectRoot(connectArgs.projectRoot, args.projectRoot);
      const cdpPort = asPositiveInt(connectArgs.cdpPort);
      if (!cdpPort) throw new Error("A valid cdpPort is required.");
      const target = pickCdpTarget(await listCdpTargets(cdpPort));
      if (!target?.webSocketDebuggerUrl) throw new Error(`No debuggable renderer target was found on CDP port ${cdpPort}.`);
      cdpAttachmentEpoch += 1;
      activeSession = {
        id: randomUUID(),
        appKind: "electron",
        label: connectArgs.label?.trim() || target.title || `Electron app on ${cdpPort}`,
        projectRoot,
        laneId,
        cwd: null,
        command: null,
        pid: null,
        terminalSessionId: null,
        terminalPtyId: null,
        cdpPort,
        cdpEndpoint: target.webSocketDebuggerUrl,
        cdpTargetId: target.id,
        provider: "cdp",
        driver: "cdp",
        chatSessionId: connectArgs.chatSessionId ?? null,
        startedAt: nowIso(),
        connectedAt: nowIso(),
        status: "connected",
        lastError: null,
        lastObservationId: null,
        lastTraceEntryId: null,
      };
      emit({ type: "session-started", session: activeSession });
      startCdpHealthCheck(activeSession.id, cdpPort);
      await startScreencast(activeSession.id, target.id, target.webSocketDebuggerUrl);
      return activeSession;
    };

    const launch = async (launchArgs: AppControlLaunchArgs = {}): Promise<AppControlSession> => {
      requireSupportedDriver(launchArgs.driver);
      const replaceableSession = activeSession && ["exited", "failed", "stopped"].includes(activeSession.status);
      if (activeSession && !replaceableSession && !launchArgs.force) {
        throw new Error("App Control already has an active session on this lane. Pass --force to replace it.");
      }
      if (!args.ptyService) {
        throw new Error("App Control terminal launch requires the ADE terminal service.");
      }
      if (activeSession) await stop({ force: true });
      cdpAttachmentEpoch += 1;
      const debugPort = asPositiveInt(launchArgs.debugPort ?? launchArgs.cdpPort) ?? await findFreePort();
      const resolved = resolveLaunch(launchArgs, debugPort);
      const projectRoot = normalizeProjectRoot(launchArgs.projectRoot, args.projectRoot);
      const session: AppControlSession = {
        id: randomUUID(),
        appKind: "electron",
        label: resolved.label,
        projectRoot,
        laneId,
        cwd: resolved.cwd,
        command: resolved.commandForDisplay,
        pid: null,
        terminalSessionId: null,
        terminalPtyId: null,
        cdpPort: debugPort,
        cdpEndpoint: null,
        cdpTargetId: null,
        provider: "cdp",
        driver: "cdp",
        chatSessionId: launchArgs.chatSessionId ?? null,
        startedAt: nowIso(),
        connectedAt: null,
        status: "starting",
        lastError: null,
        lastObservationId: null,
        lastTraceEntryId: null,
      };
      activeSession = session;
      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const launchEnv = Object.fromEntries(
        Object.entries(launchArgs.env ?? {}).map(([key, value]) => [key, value == null ? "" : value]),
      );
      const env: Record<string, string> = {
        ...inheritedEnv,
        ...launchEnv,
        ...(resolved.env ?? {}),
        ADE_APP_CONTROL: "1",
        ADE_APP_CONTROL_SESSION_ID: session.id,
        ADE_APP_CONTROL_CDP_PORT: String(debugPort),
        ADE_APP_CONTROL_REMOTE_DEBUGGING_PORT: String(debugPort),
        ADE_APP_CONTROL_REMOTE_DEBUGGING_ADDRESS: "127.0.0.1",
        ADE_APP_CONTROL_DEBUG_FLAGS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
      };
      args.logger.info("app_control.launch", {
        cwd: resolved.cwd,
        command: resolved.commandForDisplay,
        debugPort,
      });
      emit({ type: "session-started", session });
      try {
        const terminal = await args.ptyService.create({
          laneId,
          cwd: resolved.cwd,
          allowExternalCwd: true,
          cols: 120,
          rows: 36,
          title: `App Control: ${resolved.label}`,
          tracked: true,
          // Use "shell" so the session shows up in the chat sidebar nested under
          // its parent chat.
          toolType: "shell",
          startupCommand: resolved.commandForDisplay,
          ...(resolved.windowsStartupCommands
            ? { windowsStartupCommands: resolved.windowsStartupCommands }
            : {}),
          ...(resolved.command
            ? { command: resolved.command, args: resolved.args ?? [] }
            : {}),
          env,
          chatSessionId: launchArgs.chatSessionId ?? null,
        });
        const updated = updateSession({
          pid: terminal.pid ?? null,
          terminalSessionId: terminal.sessionId,
          terminalPtyId: terminal.ptyId,
          status: "running",
        }) ?? session;
        startCdpPoller(session.id, debugPort);
        return updated;
      } catch (error) {
        stopCdpPoller();
        return updateSession({
          status: "failed",
          lastError: error instanceof Error ? error.message : String(error),
        }) ?? session;
      }
    };

    const ensureConnectedSession = async (): Promise<AppControlSession> => {
      if (!activeSession) throw new Error("No active App Control session. Launch or connect first.");
      if (activeSession.cdpPort && (!activeSession.cdpEndpoint || activeSession.status !== "connected")) {
        const targets = await listCdpTargets(activeSession.cdpPort);
        // Prefer the user's previously-attached target if it still exists. Falling
        // back to pickCdpTarget on every transient disconnect would silently
        // re-attach to a different window than the one the user picked.
        const stickyTarget = activeSession.cdpTargetId
          ? targets.find((candidate) => candidate.id === activeSession?.cdpTargetId && candidate.webSocketDebuggerUrl)
          : null;
        const target = stickyTarget ?? pickCdpTarget(targets);
        if (target?.webSocketDebuggerUrl) {
          const reconnected = updateSession({
            cdpEndpoint: target.webSocketDebuggerUrl,
            cdpTargetId: target.id,
            connectedAt: activeSession.connectedAt ?? nowIso(),
            status: "connected",
            lastError: null,
          }) ?? activeSession;
          startCdpHealthCheck(reconnected.id, activeSession.cdpPort);
          void startScreencast(reconnected.id, target.id, target.webSocketDebuggerUrl).catch(() => {});
          return reconnected;
        }
      }
      if (!activeSession.cdpEndpoint) throw new Error(activeSession.lastError ?? "Active App Control session has no CDP endpoint.");
      if (
        (!screencastClient
          || screencastClient.isClosed()
          || screencastSessionId !== activeSession.id
          || screencastTargetId !== activeSession.cdpTargetId
          || screencastEndpoint !== activeSession.cdpEndpoint)
        && activeSession.status === "connected"
      ) {
        void startScreencast(activeSession.id, activeSession.cdpTargetId, activeSession.cdpEndpoint).catch(() => {});
      }
      return activeSession;
    };

    const withCdp = async <T>(fn: (client: CdpClient, session: AppControlSession) => Promise<T>): Promise<T> => {
      const session = await ensureConnectedSession();
      if (!session.cdpEndpoint) throw new Error("Active App Control session has no CDP endpoint.");
      // Reuse the persistent screencast client when it's connected to the same
      // session. This avoids opening a new WebSocket per click/scroll/key — under
      // a wheel gesture that's 30+ short-lived sockets, which CDP starts to
      // queue or drop.
      if (
        screencastClient
        && !screencastClient.isClosed()
        && screencastSessionId === session.id
        && screencastTargetId === session.cdpTargetId
        && screencastEndpoint === session.cdpEndpoint
      ) {
        return await fn(screencastClient, session);
      }
      const client = await CdpClient.connect(session.cdpEndpoint);
      try {
        return await fn(client, session);
      } finally {
        void client.close();
      }
    };

    const enablePageDomain = async (client: CdpClient): Promise<void> => {
      await client.send("Page.enable").catch(() => {});
    };

    const setWindowState = async (windowState: "normal" | "minimized"): Promise<{ ok: true }> => {
      await withCdp(async (client) => {
        let browserWindowError: Error | null = null;
        try {
          const windowInfo = await client.send<{ windowId?: number }>("Browser.getWindowForTarget");
          if (typeof windowInfo.windowId !== "number") {
            throw new Error("The active CDP target does not expose a browser window id.");
          }
          await client.send("Browser.setWindowBounds", {
            windowId: windowInfo.windowId,
            bounds: { windowState },
          });
          if (windowState === "normal") {
            await client.send("Page.bringToFront").catch(() => {});
          }
          return;
        } catch (error) {
          browserWindowError = error instanceof Error ? error : new Error(String(error));
        }
        if (process.platform === "darwin") {
          throw new Error(
            `Could not ${windowState === "normal" ? "show" : "minimize"} the controlled app window: `
            + `${browserWindowError?.message ?? "CDP window controls are unavailable."} `
            + "ADE does not fall back to title-only macOS scripting because it can target the wrong app window.",
          );
        }
        throw new Error(
          `Could not ${windowState === "normal" ? "show" : "minimize"} the controlled app window: `
          + `${browserWindowError?.message ?? "CDP window controls are unavailable."}`,
        );
      });
      return { ok: true };
    };

    const captureScreenshotWithClient = async (client: CdpClient, session: AppControlSession): Promise<AppControlScreenshot> => {
      // Prefer the most recent screencast frame: it's already the latest paint
      // the user can see, and reuses 0 CDP commands. Falls back to an explicit
      // capture only when streaming hasn't produced a frame yet.
      if (
        lastScreencastFrame
        && lastScreencastFrame.sessionId === session.id
        && lastScreencastFrame.cdpTargetId === session.cdpTargetId
        && lastScreencastFrame.width > 0
        && lastScreencastFrame.height > 0
      ) {
        return {
          sessionId: session.id,
          cdpTargetId: session.cdpTargetId,
          capturedAt: lastScreencastFrame.capturedAt,
          width: lastScreencastFrame.width,
          height: lastScreencastFrame.height,
          dataUrl: `data:${lastScreencastFrame.mimeType};base64,${lastScreencastFrame.data}`,
        };
      }
      await enablePageDomain(client);
      // Bound the captureScreenshot call independently of the global CDP timeout.
      // A backgrounded or slow renderer can sit on this for 15s otherwise, and
      // the caller (getSnapshot) almost always has the option to fall back to a
      // live frame on the next tick.
      let captureTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const captureTimeout = new Promise<never>((_, reject) => {
        captureTimeoutHandle = setTimeout(() => reject(new Error("Page.captureScreenshot timed out after 3000ms.")), 3000);
        captureTimeoutHandle.unref?.();
      });
      const response = await Promise.race([
        client.send<CdpScreenshotResponse>("Page.captureScreenshot", { format: "png", fromSurface: true }),
        captureTimeout,
      ]).finally(() => {
        if (captureTimeoutHandle) clearTimeout(captureTimeoutHandle);
      });
      const buffer = Buffer.from(response.data, "base64");
      const dimensions = imageDimensions(buffer) ?? { width: 0, height: 0 };
      return {
        sessionId: session.id,
        cdpTargetId: session.cdpTargetId,
        capturedAt: nowIso(),
        width: dimensions.width,
        height: dimensions.height,
        dataUrl: `data:image/png;base64,${response.data}`,
      };
    };

    const screenshot = async (): Promise<AppControlScreenshot> => withCdp(captureScreenshotWithClient);

    /** The lane's newest frame, when it is of the app and window attached now. */
    const currentFrame = (): AppControlScreencastFrame | null => {
      const session = activeSession;
      const frame = lastScreencastFrame;
      if (!session || !frame) return null;
      if (frame.sessionId !== session.id || frame.cdpTargetId !== session.cdpTargetId) return null;
      return frame;
    };

    let frameRequest: Promise<AppControlScreencastFrame | null> | null = null;

    /**
     * The current picture for a new viewer (the floating player, a pane that
     * mounts, a sync subscriber).
     *
     * The CDP screencast sends a frame only when the page paints, so a viewer
     * that arrives while the app is still would wait forever. The newest frame
     * is kept for it. When there is none yet, one `Page.captureScreenshot` in
     * the screencast's own format takes its place, and it is published as a
     * frame so every viewer of the lane gets it. Concurrent callers share one
     * capture.
     */
    const getLatestFrame = async (): Promise<AppControlScreencastFrame | null> => {
      const cached = currentFrame();
      if (cached) return cached;
      const session = activeSession;
      if (!session || session.status !== "connected" || !session.cdpEndpoint) return null;
      if (frameRequest) return await frameRequest;
      const request = (async (): Promise<AppControlScreencastFrame | null> => {
        try {
          return await withCdp(async (client, connected) => {
            await enablePageDomain(client);
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            const timeout = new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error("Page.captureScreenshot timed out after 3000ms.")), 3000);
              timeoutHandle.unref?.();
            });
            const [response, metrics] = await Promise.race([
              Promise.all([
                client.send<CdpScreenshotResponse>("Page.captureScreenshot", { format: "jpeg", quality: 78, fromSurface: true }),
                client.send<{ cssVisualViewport?: { clientWidth?: number; clientHeight?: number } }>("Page.getLayoutMetrics")
                  .catch(() => null),
              ]),
              timeout,
            ]).finally(() => {
              if (timeoutHandle) clearTimeout(timeoutHandle);
            });
            // A screencast frame, or another app, may have landed meanwhile.
            const raced = currentFrame();
            if (raced) return raced;
            if (activeSession?.id !== connected.id || activeSession.cdpTargetId !== connected.cdpTargetId) return null;
            const data = typeof response?.data === "string" ? response.data : "";
            if (!data) return null;
            const dimensions = imageDimensions(Buffer.from(data, "base64"));
            if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
            const cssWidth = metrics?.cssVisualViewport?.clientWidth;
            const cssHeight = metrics?.cssVisualViewport?.clientHeight;
            const viewportWidth = typeof cssWidth === "number" && cssWidth > 0 ? Math.round(cssWidth) : dimensions.width;
            const viewportHeight = typeof cssHeight === "number" && cssHeight > 0 ? Math.round(cssHeight) : dimensions.height;
            const scaleX = dimensions.width / viewportWidth;
            const scaleY = dimensions.height / viewportHeight;
            const frame: AppControlScreencastFrame = {
              sessionId: connected.id,
              laneId,
              cdpTargetId: connected.cdpTargetId,
              data,
              mimeType: "image/jpeg",
              width: dimensions.width,
              height: dimensions.height,
              scale: scaleX || 1,
              viewportWidth,
              viewportHeight,
              devicePixelRatio: scaleX || 1,
              scaleX,
              scaleY,
              capturedAt: nowIso(),
            };
            lastScreencastFrame = frame;
            emit({ type: "frame", frame });
            return frame;
          });
        } catch (error) {
          args.logger.debug?.("app_control.latest_frame_failed", {
            laneId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      })();
      frameRequest = request;
      try {
        return await request;
      } finally {
        if (frameRequest === request) frameRequest = null;
      }
    };

    const readDomSnapshotWithClient = async (client: CdpClient): Promise<DomSnapshotPayload | null> => {
      const evaluated = await client.send<CdpRuntimeEvaluateResponse<DomSnapshotPayload>>("Runtime.evaluate", {
        expression: cdpDomSnapshotScript(MAX_DOM_ELEMENTS),
        returnByValue: true,
        awaitPromise: true,
      });
      return evaluated.result?.value ?? null;
    };

    const readPointSnapshotWithClient = async (
      client: CdpClient,
      point: PointViewport,
    ): Promise<DomSnapshotPayload | null> => {
      try {
        await client.send("DOM.enable").catch(() => {});
        const located = await client.send<CdpDomGetNodeForLocationResponse>("DOM.getNodeForLocation", {
          x: Math.max(0, Math.round(point.x)),
          y: Math.max(0, Math.round(point.y)),
          includeUserAgentShadowDOM: true,
          ignorePointerEventsNone: true,
        });
        const backendNodeId = located.backendNodeId;
        if (typeof backendNodeId === "number") {
          const resolved = await client.send<CdpDomResolveNodeResponse>("DOM.resolveNode", { backendNodeId });
          const objectId = resolved.object?.objectId;
          if (objectId) {
            const called = await client.send<CdpRuntimeCallFunctionOnResponse<DomSnapshotPayload>>("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: CDP_NODE_METADATA_FUNCTION,
              returnByValue: true,
              awaitPromise: true,
            });
            if (called.result?.value) return called.result.value;
          }
        }
      } catch {
        // Fall back to in-page hit testing when a target omits DOM.getNodeForLocation.
      }
      const evaluated = await client.send<CdpRuntimeEvaluateResponse<DomSnapshotPayload>>("Runtime.evaluate", {
        expression: cdpPointSnapshotScript(point),
        returnByValue: true,
        awaitPromise: true,
      });
      return evaluated.result?.value ?? null;
    };

    const buildSnapshot = (
      session: AppControlSession,
      shot: AppControlScreenshot | null,
      dom: DomSnapshotPayload | null,
      snapshotArgs: AppControlSnapshotArgs,
      screenshotError: string | null = null,
    ): AppControlSnapshot => {
      const fallbackScale = dom?.viewport?.devicePixelRatio || 1;
      const viewport = dom?.viewport ?? {
        width: shot?.width ?? 0,
        height: shot?.height ?? 0,
        devicePixelRatio: fallbackScale,
      };
      const screenWidth = shot?.width ?? Math.round((viewport.width || 0) * fallbackScale);
      const screenHeight = shot?.height ?? Math.round((viewport.height || 0) * fallbackScale);
      const scaleX = viewport.width > 0 ? screenWidth / viewport.width : fallbackScale;
      const scaleY = viewport.height > 0 ? screenHeight / viewport.height : fallbackScale;
      const scale = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : viewport.devicePixelRatio || 1;
      const elements: AppControlElement[] = (dom?.elements ?? []).map((element, index) => {
        const frame = roundFrame(element.rect);
        return {
          id: `cdp:${index + 1}`,
          ref: `@e${index + 1}`,
          provider: "cdp",
          tagName: element.tagName,
          role: element.role,
          label: element.label,
          value: element.value,
          selector: element.selector,
          testId: element.testId,
          frame,
          pixelFrame: roundFrame({
            x: frame.x * scaleX,
            y: frame.y * scaleY,
            width: frame.width * scaleX,
            height: frame.height * scaleY,
          }),
          metadata: element.metadata ?? {},
        };
      });
      const x = typeof snapshotArgs.x === "number" ? snapshotArgs.x : null;
      const y = typeof snapshotArgs.y === "number" ? snapshotArgs.y : null;
      const hitX = snapshotArgs.coordinateSpace === "viewport" && x != null ? x * scaleX : x;
      const hitY = snapshotArgs.coordinateSpace === "viewport" && y != null ? y * scaleY : y;
      return {
        session,
        capturedAt: shot?.capturedAt ?? nowIso(),
        screenshot: shot,
        screen: {
          width: screenWidth || viewport.width,
          height: screenHeight || viewport.height,
          scale,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          devicePixelRatio: viewport.devicePixelRatio,
          scaleX,
          scaleY,
        },
        elements,
        hitElement: hitX == null || hitY == null ? null : findSmallestElementAt(elements, hitX, hitY),
        providers: [
          { provider: "screenshot", available: Boolean(shot), error: screenshotError },
          { provider: "cdp", available: true, elementCount: elements.length },
        ],
        url: dom?.url ?? null,
        title: dom?.title ?? null,
      };
    };

    const getSnapshotWithClient = async (
      client: CdpClient,
      session: AppControlSession,
      snapshotArgs: AppControlSnapshotArgs = {},
      options: { allowScreenshotFailure?: boolean; captureScreenshot?: boolean } = {},
    ): Promise<AppControlSnapshot> => {
      let shot: AppControlScreenshot | null = null;
      let screenshotError: string | null = null;
      if (options.captureScreenshot !== false) {
        try {
          shot = await captureScreenshotWithClient(client, session);
        } catch (error) {
          if (!options.allowScreenshotFailure) throw error;
          screenshotError = error instanceof Error ? error.message : String(error);
        }
      }
      const dom = await readDomSnapshotWithClient(client);
      return buildSnapshot(session, shot, dom, snapshotArgs, screenshotError);
    };

    const getPointSnapshotWithClient = async (
      client: CdpClient,
      session: AppControlSession,
      point: AppControlInspectPointArgs,
    ): Promise<AppControlSnapshot> => {
      let shot: AppControlScreenshot | null = null;
      let screenshotError: string | null = null;
      if (point.includeScreenshot) {
        try {
          shot = await captureScreenshotWithClient(client, session);
        } catch (error) {
          screenshotError = error instanceof Error ? error.message : String(error);
        }
      }
      const viewportPoint = await normalizeViewportPoint(client, point);
      const dom = await readPointSnapshotWithClient(client, viewportPoint);
      return buildSnapshot(
        session,
        shot,
        dom,
        { projectRoot: point.projectRoot, x: viewportPoint.x, y: viewportPoint.y, coordinateSpace: "viewport" },
        screenshotError,
      );
    };

    const getViewportScale = async (client: CdpClient): Promise<number> => {
      const evaluated = await client.send<CdpRuntimeEvaluateResponse<{ devicePixelRatio?: number }>>("Runtime.evaluate", {
        expression: "({ devicePixelRatio: window.devicePixelRatio || 1 })",
        returnByValue: true,
        awaitPromise: true,
      });
      const scale = evaluated.result?.value?.devicePixelRatio;
      return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
    };

    const normalizeViewportPoint = async (
      client: CdpClient,
      point: { x: number; y: number; scale?: number | null; coordinateSpace?: AppControlCoordinateSpace | null },
    ): Promise<PointViewport> => {
      if (point.coordinateSpace === "viewport") {
        return {
          x: Math.max(0, round(point.x)),
          y: Math.max(0, round(point.y)),
        };
      }
      const explicitScale = typeof point.scale === "number" && Number.isFinite(point.scale) && point.scale > 0
        ? point.scale
        : null;
      const fallbackScale = explicitScale ?? await getViewportScale(client);
      const scaleX = explicitScale
        ?? (lastScreencastFrame?.scaleX && lastScreencastFrame.scaleX > 0 ? lastScreencastFrame.scaleX : fallbackScale);
      const scaleY = explicitScale
        ?? (lastScreencastFrame?.scaleY && lastScreencastFrame.scaleY > 0 ? lastScreencastFrame.scaleY : scaleX);
      return {
        x: Math.max(0, round(point.x / scaleX)),
        y: Math.max(0, round(point.y / scaleY)),
      };
    };

    const getInputPageState = async (client: CdpClient): Promise<CdpInputPageState> => {
      const evaluated = await client.send<CdpRuntimeEvaluateResponse<CdpInputPageState>>("Runtime.evaluate", {
        expression: "({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState })",
        returnByValue: true,
        awaitPromise: true,
      });
      const value = evaluated.result?.value;
      return {
        hasFocus: Boolean(value?.hasFocus),
        visibilityState: typeof value?.visibilityState === "string" ? value.visibilityState : "unknown",
      };
    };

    const dispatchDomClick = async (client: CdpClient, point: { x: number; y: number }): Promise<CdpDomClickResult> => {
      const evaluated = await client.send<CdpRuntimeEvaluateResponse<CdpDomClickResult>>("Runtime.evaluate", {
        expression: cdpDomClickScript(point),
        returnByValue: true,
        awaitPromise: true,
      });
      return evaluated.result?.value ?? { ok: false, target: null, label: null };
    };

    const getSnapshot = async (snapshotArgs: AppControlSnapshotArgs = {}): Promise<AppControlSnapshot> => withCdp(async (client, session) => {
      // Tolerate screenshot failure so that a slow or backgrounded renderer
      // doesn't take the whole snapshot down. The DOM elements still arrive,
      // and the renderer falls back to whatever live frame it last received.
      return getSnapshotWithClient(client, session, snapshotArgs, { allowScreenshotFailure: true });
    });

    const contextItemFromElement = (
      element: AppControlElement,
      snapshot: AppControlSnapshot,
      screenshotDataUrl?: string | null,
      projectRootOverride?: string | null,
    ): AppControlContextItem => {
      const projectRoot = normalizeProjectRoot(projectRootOverride ?? snapshot.session?.projectRoot ?? activeSession?.projectRoot, args.projectRoot);
      const sourceMatches = findSourceMatches(projectRoot, element, sourceFileCache);
      const exact = sourceMatches.find((match) => match.confidence === "exact") ?? null;
      const candidate = sourceMatches[0] ?? null;
      const sourceFile = exact?.sourceFile ?? candidate?.sourceFile ?? null;
      const sourceLine = exact?.sourceLine ?? candidate?.sourceLine ?? null;
      const sourceSnippet = readSourceSnippet(projectRoot, sourceFile, sourceLine);
      return {
        kind: "app_control_element",
        id: randomUUID(),
        appKind: "electron",
        sessionId: snapshot.session?.id ?? null,
        provider: element.provider,
        componentId: element.testId ?? element.label ?? element.selector ?? element.role ?? element.tagName ?? "Electron element",
        sourceFile,
        sourceLine,
        frame: element.pixelFrame,
        metadata: {
          appControlPacketVersion: 1,
          provider: element.provider,
          selectedElement: compactElement(element),
          nearbyElements: nearbyElements(snapshot, element),
          screen: snapshot.screen,
          url: snapshot.url,
          title: snapshot.title,
          sourceConfidence: exact ? "exact" : candidate ? "candidate" : "none",
          sourceResolution: exact ? "source-search-exact" : candidate ? "source-search-candidate" : "none",
          sourceCandidates: sourceMatches,
          sourceSnippet,
          label: element.label,
          value: element.value,
          role: element.role,
          tagName: element.tagName,
          selector: element.selector,
          testId: element.testId,
          session: snapshot.session,
          selectionExplanation: "The user selected this UI element from ADE App Control. The screenshot or crop attachment is visual evidence for this packet; frames are in screenshot pixels.",
        },
        screenshotDataUrl: screenshotDataUrl ?? undefined,
        selectedAt: nowIso(),
      };
    };

    const coordinateFallbackItem = (
      point: { x: number; y: number },
      snapshot: AppControlSnapshot,
      screenshotDataUrl?: string | null,
    ): AppControlContextItem => ({
      kind: "app_control_element",
      id: randomUUID(),
      appKind: "electron",
      sessionId: snapshot.session?.id ?? null,
      provider: "coordinate-fallback",
      componentId: "App coordinate",
      sourceFile: null,
      sourceLine: null,
      frame: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 },
      metadata: {
        appControlPacketVersion: 1,
        provider: "coordinate-fallback",
        selectedElement: {
          provider: "coordinate-fallback",
          screenshotFrame: { x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1 },
        },
        screen: snapshot.screen,
        url: snapshot.url,
        title: snapshot.title,
        sourceConfidence: "none",
        session: snapshot.session,
        note: "No DOM element matched this point; App Control preserved the selected coordinate and screenshot.",
      },
      screenshotDataUrl: screenshotDataUrl ?? undefined,
      selectedAt: nowIso(),
    });

    const screenshotPointFromInspectArgs = (
      point: AppControlInspectPointArgs,
      snapshot: AppControlSnapshot,
    ): { x: number; y: number } => point.coordinateSpace === "viewport"
      ? {
        x: point.x * (snapshot.screen.scaleX ?? snapshot.screen.scale),
        y: point.y * (snapshot.screen.scaleY ?? snapshot.screen.scale),
      }
      : { x: point.x, y: point.y };

    const inspectPoint = async (point: AppControlInspectPointArgs): Promise<AppControlInspectResult> => {
      const snapshot = await withCdp((client, session) => getPointSnapshotWithClient(client, session, point));
      if (!snapshot.hitElement) {
        return {
          item: coordinateFallbackItem(
            screenshotPointFromInspectArgs(point, snapshot),
            snapshot,
            point.includeScreenshot ? snapshot.screenshot?.dataUrl : null,
          ),
          source: "coordinate-fallback",
          snapshot,
        };
      }
      return {
        item: contextItemFromElement(snapshot.hitElement, snapshot, point.includeScreenshot ? snapshot.screenshot?.dataUrl : null, point.projectRoot),
        source: snapshot.hitElement.provider,
        snapshot,
      };
    };

    const selectPoint = async (point: AppControlInspectPointArgs): Promise<AppControlSelectResult> => {
      const snapshot = await withCdp((client, session) => getPointSnapshotWithClient(client, session, point));
      const fallbackPoint = screenshotPointFromInspectArgs(point, snapshot);
      const item = snapshot.hitElement
        ? contextItemFromElement(snapshot.hitElement, snapshot, snapshot.screenshot?.dataUrl, point.projectRoot)
        : coordinateFallbackItem(fallbackPoint, snapshot, snapshot.screenshot?.dataUrl);
      lastSelectedItem = item;
      emit({ type: "selection", item });
      return { item, source: snapshot.hitElement?.provider ?? "coordinate-fallback", snapshot };
    };

    const click = async (clickArgs: AppControlClickArgs): Promise<{ ok: true }> => {
      await withCdp(async (client) => {
        await enablePageDomain(client);
        const point = await normalizeViewportPoint(client, clickArgs);
        const pageState = await getInputPageState(client).catch(() => null);
        if (pageState?.visibilityState === "hidden") {
          const domResult = await dispatchDomClick(client, point);
          if (domResult.ok) return;
        }
        // Send the click directly. Some Electron renderers can stall a standalone
        // mouseMoved CDP command, and awaiting it here means the press/release
        // never reach the app. The pressed/released events carry coordinates, so
        // Chromium still targets the element under the point.
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
      });
      return { ok: true };
    };

    const typeText = async (typeArgs: AppControlTypeTextArgs): Promise<{ ok: true }> => {
      const text = typeArgs.text;
      if (!text) return { ok: true };
      await withCdp(async (client) => {
        await enablePageDomain(client);
        await client.send("Input.insertText", { text });
      });
      return { ok: true };
    };

    const scroll = async (scrollArgs: {
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      scale?: number | null;
      coordinateSpace?: AppControlCoordinateSpace | null;
    }): Promise<{ ok: true }> => {
      const deltaX = Math.round(scrollArgs.deltaX);
      const deltaY = Math.round(scrollArgs.deltaY);
      await withCdp(async (client) => {
        const point = await normalizeViewportPoint(client, scrollArgs);
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Math.round(point.x),
          y: Math.round(point.y),
          deltaX,
          deltaY,
          button: "none",
          modifiers: 0,
        });
      });
      return { ok: true };
    };

    type KeyEventArgs = {
      type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      key?: string | null;
      code?: string | null;
      text?: string | null;
      unmodifiedText?: string | null;
      modifiers?: number | null;
      autoRepeat?: boolean | null;
      isKeypad?: boolean | null;
      location?: number | null;
      windowsVirtualKeyCode?: number | null;
      nativeVirtualKeyCode?: number | null;
    };
    const dispatchKey = async (keyArgs: KeyEventArgs): Promise<{ ok: true }> => {
      const payload: Record<string, unknown> = { type: keyArgs.type };
      if (keyArgs.key) payload.key = keyArgs.key;
      if (keyArgs.code) payload.code = keyArgs.code;
      if (keyArgs.text) payload.text = keyArgs.text;
      if (keyArgs.unmodifiedText) payload.unmodifiedText = keyArgs.unmodifiedText;
      if (typeof keyArgs.modifiers === "number") payload.modifiers = keyArgs.modifiers;
      if (typeof keyArgs.autoRepeat === "boolean") payload.autoRepeat = keyArgs.autoRepeat;
      if (typeof keyArgs.isKeypad === "boolean") payload.isKeypad = keyArgs.isKeypad;
      if (typeof keyArgs.location === "number") payload.location = keyArgs.location;
      if (typeof keyArgs.windowsVirtualKeyCode === "number") payload.windowsVirtualKeyCode = keyArgs.windowsVirtualKeyCode;
      if (typeof keyArgs.nativeVirtualKeyCode === "number") payload.nativeVirtualKeyCode = keyArgs.nativeVirtualKeyCode;
      await withCdp(async (client) => {
        await enablePageDomain(client);
        await client.send("Input.dispatchKeyEvent", payload);
      });
      return { ok: true };
    };

    const listTargets = async (): Promise<AppControlTarget[]> => {
      if (!activeSession?.cdpPort) return [];
      let targets: CdpTarget[];
      try {
        targets = await listCdpTargets(activeSession.cdpPort);
      } catch {
        // The controlled app may have just exited or hasn't bound the CDP port
        // yet. Treat as "no targets" rather than surfacing a connection error
        // every poll.
        return [];
      }
      const activeTargetId = activeSession.cdpTargetId;
      return targets
        .filter((target) => target.type === "page" && Boolean(target.webSocketDebuggerUrl))
        .filter((target) => {
          const title = `${target.title ?? ""} ${target.url ?? ""}`.toLowerCase();
          return !title.includes("devtools") && !title.includes("developer tools");
        })
        .map((target) => ({
          id: target.id,
          title: target.title ?? null,
          url: target.url ?? null,
          type: target.type,
          active: target.id === activeTargetId,
        }))
        // Stable ordering: /json/list returns targets in arbitrary order which
        // can swap between polls, making any positional label ("Window 1") lie
        // about which underlying target it refers to. Sort by id so the same
        // target is always at the same position.
        .sort((a, b) => a.id.localeCompare(b.id));
    };

    const attachToTarget = async (targetId: string): Promise<AppControlSession> => {
      if (!activeSession || !activeSession.cdpPort) {
        throw new Error("No active App Control session.");
      }
      const id = (targetId ?? "").trim();
      if (!id) throw new Error("attachToTarget requires a targetId.");
      const sessionId = activeSession.id;
      const cdpPort = activeSession.cdpPort;
      const attachEpoch = cdpAttachmentEpoch + 1;
      cdpAttachmentEpoch = attachEpoch;
      stopCdpHealthCheck();
      const targets = await listCdpTargets(cdpPort);
      if (!activeSession || activeSession.id !== sessionId || cdpAttachmentEpoch !== attachEpoch) {
        if (!activeSession) throw new Error("No active App Control session.");
        return activeSession;
      }
      const target = targets.find((candidate) => candidate.id === id && candidate.webSocketDebuggerUrl);
      if (!target?.webSocketDebuggerUrl) {
        startCdpHealthCheck(sessionId, cdpPort);
        throw new Error(`No CDP target with id '${id}' is currently debuggable.`);
      }
      await stopScreencast();
      const updated = updateSession({
        cdpEndpoint: target.webSocketDebuggerUrl,
        cdpTargetId: target.id,
        connectedAt: nowIso(),
        status: "connected",
        lastError: null,
      }) ?? activeSession;
      await startScreencast(updated.id, target.id, target.webSocketDebuggerUrl);
      if (updated.cdpPort) startCdpHealthCheck(updated.id, updated.cdpPort);
      return updated;
    };

    const requireTerminalSessionId = (): string => {
      const terminalId = activeSession?.terminalSessionId;
      if (!terminalId) throw new Error("App Control has no launch terminal for the active session.");
      if (!args.ptyService) throw new Error("App Control terminal access requires the ADE terminal service.");
      return terminalId;
    };

    const readTerminal = async (terminalArgs: { maxBytes?: number | null; since?: number | null } = {}) => {
      const terminalId = requireTerminalSessionId();
      return await args.ptyService!.readTerminal({
        terminalId,
        maxBytes: terminalArgs.maxBytes,
        since: terminalArgs.since,
      });
    };

    const writeTerminal = async (terminalArgs: { data?: string | null }): Promise<{ ok: true }> => {
      const terminalId = requireTerminalSessionId();
      if (typeof terminalArgs?.data !== "string") throw new Error("App Control terminal write requires data.");
      return await args.ptyService!.writeTerminal({ terminalId, data: terminalArgs.data });
    };

    const signalTerminal = (terminalArgs: { signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | null } = {}): { ok: true } => {
      const terminalId = requireTerminalSessionId();
      return args.ptyService!.signalTerminal({ terminalId, signal: terminalArgs.signal ?? "SIGINT" });
    };

    // =====================================================================
    // Agent action model
    //
    // The agent surface (observe + the eight `agentX` actions + the trace) lives
    // in `appControlAgentActions.ts`; it is one responsibility that reaches the
    // session machinery only through the deps below. The legacy `click` /
    // `typeText` / `scroll` / `dispatchKey` primitives above stay here for the
    // renderer's live-frame input.
    // =====================================================================

    const agentActions = createAppControlAgentActions({
      logger: args.logger,
      resolveProjectRoot: (sessionProjectRoot) => normalizeProjectRoot(sessionProjectRoot, args.projectRoot),
      getActiveSession: () => activeSession,
      updateSession,
      withCdp,
      enablePageDomain,
      normalizeViewportPoint,
      snapshotDiagnostics: () => ({
        capturedAt: nowIso(),
        pendingRequestCount: pendingNetworkRequests.size,
        console: [...consoleDiagnostics],
        network: [...networkDiagnostics],
      }),
      isNetworkIdle: (idleMs) => (
        pendingNetworkRequests.size === 0 && Date.now() - lastNetworkActivityAtMs >= idleMs
      ),
      getLastScreencastFrame: () => lastScreencastFrame,
      imageDimensions,
    });

    const {
      agentSessionFor,
      observe,
      agentClick,
      agentHover,
      agentFill,
      agentClear,
      agentType,
      agentPress,
      agentScroll,
      agentWait,
      getTrace,
    } = agentActions;

    const windows = async (input: AppControlSessionTargetArgs = {}): Promise<AppControlWindowsResult> => {
      const session = agentSessionFor(input);
      return {
        sessionId: session.id,
        activeTargetId: session.cdpTargetId,
        windows: await listTargets(),
      };
    };

    const switchWindow = async (input: AppControlSwitchWindowArgs): Promise<AppControlWindowsResult> => {
      agentSessionFor(input);
      const targetId = stringOrNull(input.targetId);
      if (!targetId) throw new Error("App Control switchWindow requires a targetId.");
      const updated = await attachToTarget(targetId);
      // A different window means a different document: handles minted against
      // the previous target no longer resolve (`readObservationElementHandle`
      // rejects them by `cdpTargetId`), so start the trace ledger clean rather
      // than letting stale entries look current.
      agentActions.resetTrace();
      return {
        sessionId: updated.id,
        activeTargetId: updated.cdpTargetId,
        windows: await listTargets(),
      };
    };

    const focusWindow = (): Promise<{ ok: true }> => setWindowState("normal");
    const minimizeWindow = (): Promise<{ ok: true }> => setWindowState("minimized");

    return {
      laneId,
      getSession: (): AppControlSession | null => activeSession,
      getLastFrame: (): AppControlScreencastFrame | null => lastScreencastFrame,
      getLatestFrame,
      getLastSelectedItem: (): AppControlContextItem | null => lastSelectedItem,
      getTargetTitle: async (): Promise<string | null> => {
        const session = activeSession;
        if (!session?.cdpPort || !session.cdpTargetId) return null;
        const targets = await listCdpTargets(session.cdpPort).catch(() => [] as CdpTarget[]);
        return targets.find((target) => target.id === session.cdpTargetId)?.title?.trim() || null;
      },
      resolveAppProcessId,
      claim,
      launch,
      connect,
      stop,
      focusWindow,
      minimizeWindow,
      screenshot,
      getSnapshot,
      inspectPoint,
      selectPoint,
      click,
      typeText,
      readTerminal,
      writeTerminal,
      signalTerminal,
      scroll,
      dispatchKey,
      listTargets,
      attachToTarget,
      listDrivers: (): AppControlDriversResult => listDriversFor(activeSession),
      observe,
      agentClick,
      agentHover,
      agentFill,
      agentClear,
      agentType,
      agentPress,
      agentScroll,
      agentWait,
      getTrace,
      windows,
      switchWindow,
      dispose: (): void => {
        unsubscribePtyExit?.();
        flushDiagnostics();
        stopCdpPoller();
        stopCdpHealthCheck();
        void stopScreencast();
        void stop({ force: true }).catch(() => {});
      },
    };
  }

  type LaneController = ReturnType<typeof createLaneController>;

  const controllerFor = (laneId: string): LaneController => {
    let controller = controllers.get(laneId);
    if (!controller) {
      controller = createLaneController(laneId);
      controllers.set(laneId, controller);
    }
    return controller;
  };

  const liveSessions = (): AppControlSession[] =>
    [...controllers.values()]
      .map((controller) => controller.getSession())
      .filter((session): session is AppControlSession => Boolean(session));

  /**
   * The lane a call acts on: the one it names, else the lane of the session id
   * it holds, else its chat's lane. There is no "first lane" fallback: a call
   * that resolves to no lane is refused by `requireLaneId`.
   */
  /** The lane a call names, from what this service already knows. No lookups. */
  const knownLaneId = (ref: AppControlLaneRef | null | undefined): string | null => {
    const explicit = cleanClaimId(ref?.laneId);
    if (explicit) return explicit;
    const sessionId = cleanClaimId(ref?.sessionId);
    if (sessionId) {
      const owner = [...controllers.values()].find((controller) => controller.getSession()?.id === sessionId);
      if (owner) return owner.laneId;
    }
    const chatSessionId = cleanClaimId(ref?.chatSessionId);
    if (chatSessionId) {
      const owned = [...controllers.values()].find((controller) => controller.getSession()?.chatSessionId === chatSessionId);
      if (owned) return owned.laneId;
    }
    return null;
  };

  const resolveCallLaneId = async (
    ref: AppControlLaneRef | null | undefined,
    options: { cwd?: string | null; projectRoot?: string | null } = {},
  ): Promise<string | null> => {
    const known = knownLaneId(ref);
    if (known) return known;
    const chatSessionId = cleanClaimId(ref?.chatSessionId);
    if (chatSessionId) {
      const chatLane = args.resolveChatLaneId
        ? await Promise.resolve(args.resolveChatLaneId(chatSessionId)).catch(() => null)
        : null;
      if (chatLane?.trim()) return chatLane.trim();
    }
    if (options.cwd || (chatSessionId && !args.resolveChatLaneId)) {
      const projectRoot = normalizeProjectRoot(options.projectRoot, args.projectRoot);
      const resolved = await Promise.resolve(args.resolveLaneId?.({
        projectRoot,
        cwd: options.cwd ?? projectRoot,
        laneId: null,
        chatSessionId,
      })).catch(() => null);
      if (resolved?.trim()) return resolved.trim();
    }
    return null;
  };

  const requireLaneId = async (
    ref: AppControlLaneRef | null | undefined,
    action: string,
    options: { cwd?: string | null; projectRoot?: string | null } = {},
  ): Promise<string> => {
    const laneId = await resolveCallLaneId(ref, options);
    if (!laneId) {
      throw new Error(
        `App Control ${action} needs a lane. Pass laneId, or call it from a chat or from inside a lane worktree.`,
      );
    }
    return laneId;
  };

  /** The lane's controller for an action on its session. Refuses a lane with none. */
  const sessionController = async (ref: AppControlLaneRef | null | undefined, action: string): Promise<LaneController> => {
    const laneId = await requireLaneId(ref, action);
    const controller = controllers.get(laneId);
    if (!controller?.getSession()) {
      throw new Error(`No App Control session on lane ${laneId}. Launch or connect an app first.`);
    }
    return controller;
  };

  /**
   * The lane's session, plus every lane's for user clients. Synchronous, so it
   * resolves the lane only from what the service holds: a named lane, a
   * session id, or a chat that owns a session.
   */
  const getStatus = (ref: AppControlLaneRef = {}): AppControlStatus => {
    const laneId = knownLaneId(ref);
    const activeSession = laneId ? controllers.get(laneId)?.getSession() ?? null : null;
    return {
      platform: process.platform,
      supported: true,
      laneId,
      activeSession,
      sessions: liveSessions(),
      providers: providersFor(activeSession),
    };
  };

  const claim = async (claimArgs: AppControlClaimArgs = {}): Promise<AppControlStatus> => {
    const laneId = await requireLaneId(claimArgs, "claim");
    controllers.get(laneId)?.claim(claimArgs);
    return getStatus({ laneId });
  };

  const launch = async (launchArgs: AppControlLaunchArgs = {}): Promise<AppControlSession> => {
    requireSupportedDriver(launchArgs.driver);
    const projectRoot = normalizeProjectRoot(launchArgs.projectRoot, args.projectRoot);
    const cwd = normalizeCwd(launchArgs.cwd, projectRoot);
    const laneId = await resolveCallLaneId(launchArgs, { cwd, projectRoot });
    if (!laneId) {
      throw new Error("App Control could not resolve a lane for the terminal. Select a lane or pass laneId.");
    }
    return await controllerFor(laneId).launch({ ...launchArgs, laneId });
  };

  const connect = async (connectArgs: AppControlConnectArgs): Promise<AppControlSession> => {
    requireSupportedDriver(connectArgs.driver);
    const laneId = await requireLaneId(connectArgs, "connect");
    return await controllerFor(laneId).connect({ ...connectArgs, laneId });
  };

  const stop = async (stopArgs: AppControlStopArgs = {}): Promise<{ ok: true; previousSession: AppControlSession | null }> => {
    const laneId = await requireLaneId(stopArgs, "stop");
    const controller = controllers.get(laneId);
    if (!controller) return { ok: true, previousSession: null };
    return await controller.stop(stopArgs);
  };

  /** A chat ended: its recordings file themselves and the sessions it owns stop. */
  const stopForChat = async (chatSessionId: string): Promise<void> => {
    const chatId = chatSessionId?.trim();
    if (!chatId) return;
    await recording.stopForChat(chatId);
    const owned = [...controllers.values()].filter((controller) => {
      const session = controller.getSession();
      return session?.chatSessionId === chatId && !["stopped", "exited", "failed"].includes(session.status);
    });
    await Promise.all(owned.map((controller) => controller.stop({}).catch((error: unknown) => {
      args.logger.debug("app_control.stop_for_chat_failed", {
        laneId: controller.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    })));
  };

  /** A lane was archived or deleted: its session stops and its state is dropped. */
  const stopForLane = async (laneId: string): Promise<void> => {
    const id = laneId?.trim();
    if (!id) return;
    const controller = controllers.get(id);
    if (controller?.getSession()) {
      await controller.stop({}).catch((error: unknown) => {
        args.logger.debug("app_control.stop_for_lane_failed", {
          laneId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      await recording.stopForAppClosed(id);
    }
    controller?.dispose();
    controllers.delete(id);
    recording.forgetLane(id);
  };

  const onLane = <T,>(action: string, run: (controller: LaneController) => Promise<T> | T) =>
    async (ref: AppControlLaneRef = {}): Promise<T> => await run(await sessionController(ref, action));

  const selectPoint = async (point: AppControlInspectPointArgs): Promise<AppControlSelectResult> => {
    const result = await (await sessionController(point, "selectPoint")).selectPoint(point);
    lastSelectedItemAnyLane = result.item;
    return result;
  };

  const attachToTarget = async (
    input: string | AppControlAttachToTargetArgs,
    ref: AppControlLaneRef = {},
  ): Promise<AppControlSession> => {
    const targetArgs: AppControlAttachToTargetArgs = typeof input === "string" ? { ...ref, targetId: input } : input;
    return await (await sessionController(targetArgs, "attachToTarget")).attachToTarget(targetArgs.targetId);
  };

  const startRecording = async (recordArgs: AppControlRecordStartArgs = {}): Promise<AppControlRecordingStatus> => {
    const laneId = await requireLaneId(recordArgs, "startRecording");
    return await recording.startRecording(laneId, recordArgs);
  };

  const stopRecording = async (recordArgs: AppControlRecordStopArgs = {}): Promise<AppControlRecordingStatus> => {
    const laneId = await requireLaneId(recordArgs, "stopRecording");
    return await recording.stopRecording(laneId, cleanClaimId(recordArgs.chatSessionId));
  };

  const getRecordingStatus = async (recordArgs: AppControlRecordingStatusArgs = {}): Promise<AppControlRecordingStatus> => {
    const laneId = await requireLaneId(recordArgs, "getRecordingStatus");
    return recording.getStatus(laneId);
  };

  /**
   * One still of the lane's app, filed as proof: Mac Desktop's Save screenshot
   * for App Control. The capture is the agent observation's (a fresh
   * `Page.captureScreenshot`, the last live frame only when that fails), so
   * the pane, the CLI and an agent all file the same picture. Owners and
   * provenance match a Mac Desktop still: lane, calling chat, the lane's PR,
   * `ade-capture`.
   */
  const captureProof = async (proofArgs: AppControlCaptureProofArgs = {}): Promise<AppControlCaptureProofResult> => {
    const controller = await sessionController(proofArgs, "captureProof");
    const laneId = controller.laneId;
    const chatSessionId = cleanClaimId(proofArgs.chatSessionId);
    if (!args.ingestArtifacts) {
      throw new Error("App Control proof is unavailable: this ADE host has no proof store.");
    }
    const shot = await controller.observe({ includeDom: false, includeDiagnostics: false });
    // The page title and the lane, never the launch command.
    const caption = proofArgs.caption?.trim() || appControlProofCaption(
      shot.title?.trim() || await controller.getTargetTitle().catch(() => null),
      await Promise.resolve(args.resolveLaneName?.(laneId)).catch(() => null),
    );
    const owners: ComputerUseArtifactOwner[] = [{ kind: "lane", id: laneId, relation: "attached_to" }];
    if (chatSessionId) owners.push({ kind: "chat_session", id: chatSessionId, relation: "attached_to" });
    const prUrl = (await Promise.resolve(args.resolvePrimaryPrUrl?.(laneId)).catch(() => null))?.trim() || null;
    if (prUrl) owners.push({ kind: "github_pr", id: prUrl, relation: "published_to" });
    let filed: ComputerUseArtifactIngestionResult;
    try {
      filed = await args.ingestArtifacts({
        backend: { name: APP_CONTROL_PROOF_BACKEND_NAME, style: "manual", toolName: "app-control proof" },
        callerRoot: args.projectRoot,
        // ADE wrote this frame just now. A still app gives the same bytes
        // twice, and that is a real capture, not a copied proof.
        provenance: { source: "ade-capture" },
        inputs: [{
          kind: "screenshot",
          title: caption,
          description: caption,
          path: shot.filePath,
          metadata: { width: shot.width, height: shot.height, url: shot.url, pageTitle: shot.title },
        }],
        owners,
      });
    } catch (error) {
      args.logger.warn("app_control.screenshot_proof_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `The screenshot was taken (${shot.filePath}), but it could not be filed as proof: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const filedRecord = filed?.artifacts[0] ?? null;
    const artifactId = filedRecord?.id ?? null;
    if (!artifactId) {
      throw new Error(`The screenshot was taken (${shot.filePath}), but the proof store filed no record.`);
    }
    // The filed copy, not the observation: the scratch file is pruned once filed.
    const filedUri = filedRecord?.uri?.trim() ?? "";
    const filedPath = filedUri && !/^[a-z][a-z0-9+.-]*:\/\//i.test(filedUri)
      ? path.resolve(args.projectRoot, filedUri)
      : shot.filePath;
    return {
      artifactId,
      filePath: filedPath,
      width: shot.width,
      height: shot.height,
      caption,
      laneId,
      chatSessionId,
      artifacts: filed.artifacts,
      links: filed.links,
      ...(filed.warnings?.length ? { warnings: filed.warnings } : {}),
    };
  };

  return {
    getStatus,
    claim,
    launch,
    launchInTerminal: launch,
    connect,
    stop,
    stopForChat,
    stopForLane,
    focusWindow: onLane("focusWindow", (controller) => controller.focusWindow()),
    minimizeWindow: onLane("minimizeWindow", (controller) => controller.minimizeWindow()),
    screenshot: onLane("screenshot", (controller) => controller.screenshot()),
    getSnapshot: async (snapshotArgs: AppControlSnapshotArgs = {}): Promise<AppControlSnapshot> =>
      await (await sessionController(snapshotArgs, "getSnapshot")).getSnapshot(snapshotArgs),
    inspectPoint: async (point: AppControlInspectPointArgs): Promise<AppControlInspectResult> =>
      await (await sessionController(point, "inspectPoint")).inspectPoint(point),
    selectPoint,
    click: async (clickArgs: AppControlClickArgs): Promise<{ ok: true }> =>
      await (await sessionController(clickArgs, "click")).click(clickArgs),
    typeText: async (typeArgs: AppControlTypeTextArgs): Promise<{ ok: true }> =>
      await (await sessionController(typeArgs, "typeText")).typeText(typeArgs),
    readTerminal: async (terminalArgs: AppControlLaneRef & { maxBytes?: number | null; since?: number | null } = {}) =>
      await (await sessionController(terminalArgs, "readTerminal")).readTerminal(terminalArgs),
    writeTerminal: async (terminalArgs: AppControlLaneRef & { data?: string | null }): Promise<{ ok: true }> =>
      await (await sessionController(terminalArgs, "writeTerminal")).writeTerminal(terminalArgs),
    signalTerminal: async (
      terminalArgs: AppControlLaneRef & { signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | null } = {},
    ): Promise<{ ok: true }> =>
      (await sessionController(terminalArgs, "signalTerminal")).signalTerminal(terminalArgs),
    getLastSelectedItem: (ref: AppControlLaneRef = {}): AppControlContextItem | null => {
      const laneId = cleanClaimId(ref.laneId);
      return laneId ? controllers.get(laneId)?.getLastSelectedItem() ?? null : lastSelectedItemAnyLane;
    },
    dispose: () => {
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
      recording.dispose();
    },
    scroll: async (scrollArgs: AppControlScrollArgs): Promise<{ ok: true }> =>
      await (await sessionController(scrollArgs, "scroll")).scroll(scrollArgs),
    dispatchKey: async (keyArgs: AppControlDispatchKeyArgs): Promise<{ ok: true }> =>
      await (await sessionController(keyArgs, "dispatchKey")).dispatchKey(keyArgs),
    listTargets: async (ref: AppControlLaneRef = {}): Promise<AppControlTarget[]> => {
      const laneId = await resolveCallLaneId(ref);
      const controller = laneId ? controllers.get(laneId) : null;
      return controller ? await controller.listTargets() : [];
    },
    attachToTarget,
    // Agent action model (parity with the built-in browser).
    listDrivers: (ref: AppControlLaneRef = {}): AppControlDriversResult => {
      const laneId = knownLaneId(ref);
      return listDriversFor(laneId ? controllers.get(laneId)?.getSession() ?? null : null);
    },
    observe: async (input: AppControlObservationArgs = {}) =>
      await (await sessionController(input, "observe")).observe(input),
    agentClick: async (input: AppControlAgentClickArgs) =>
      await (await sessionController(input, "agentClick")).agentClick(input),
    agentHover: async (input: AppControlAgentHoverArgs) =>
      await (await sessionController(input, "agentHover")).agentHover(input),
    agentFill: async (input: AppControlAgentFillArgs) =>
      await (await sessionController(input, "agentFill")).agentFill(input),
    agentClear: async (input: AppControlAgentClearArgs) =>
      await (await sessionController(input, "agentClear")).agentClear(input),
    agentType: async (input: AppControlAgentTypeArgs) =>
      await (await sessionController(input, "agentType")).agentType(input),
    agentPress: async (input: AppControlAgentPressArgs) =>
      await (await sessionController(input, "agentPress")).agentPress(input),
    agentScroll: async (input: AppControlAgentScrollArgs) =>
      await (await sessionController(input, "agentScroll")).agentScroll(input),
    agentWait: async (input: AppControlAgentWaitArgs) =>
      await (await sessionController(input, "agentWait")).agentWait(input),
    getTrace: (input: AppControlTraceArgs = {}) => {
      const laneId = knownLaneId(input);
      const controller = laneId ? controllers.get(laneId) : null;
      if (!controller?.getSession()) {
        throw new Error(laneId
          ? `No App Control session on lane ${laneId}. Launch or connect an app first.`
          : "App Control getTrace needs a lane. Pass laneId, or call it from a chat or from inside a lane worktree.");
      }
      return controller.getTrace(input);
    },
    windows: async (input: AppControlSessionTargetArgs = {}): Promise<AppControlWindowsResult> =>
      await (await sessionController(input, "windows")).windows(input),
    switchWindow: async (input: AppControlSwitchWindowArgs): Promise<AppControlWindowsResult> =>
      await (await sessionController(input, "switchWindow")).switchWindow(input),
    // Recording (same contract as Mac Desktop's).
    startRecording,
    stopRecording,
    getRecordingStatus,
    captureProof,
    /**
     * The lane's current picture for a new viewer: the newest screencast
     * frame, or one fresh capture when a still app has sent none. Null with no
     * connected session on the lane.
     */
    getLatestFrame: async (ref: AppControlLaneRef = {}): Promise<AppControlScreencastFrame | null> => {
      const laneId = await resolveCallLaneId(ref);
      const controller = laneId ? controllers.get(laneId) : null;
      return controller ? await controller.getLatestFrame() : null;
    },
  };
}
