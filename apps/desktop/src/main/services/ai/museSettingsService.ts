/**
 * Settings > Providers > Muse Code, on the machine the page is showing.
 *
 * Muse's plugins, marketplaces, skills, hooks, computer-use setup and feedback
 * all live behind MSP, and most of those methods are per session. Settings
 * therefore owns its own short-lived `muse serve` host, one per page visit
 * (`handleId`), with one memory-only scratch session in the project root. It
 * never borrows a chat's host: a chat host carries that chat's sandbox posture
 * and MCP servers, and a Settings click must not land in someone's turn.
 *
 * The host is `--no-session-log` (ephemeral), so the scratch session leaves
 * nothing on disk for `muse resume` or ADE's session import to find. It closes
 * when the page says so, after `IDLE_CLOSE_MS` without a call (a renderer that
 * vanished cannot leak it), and when the process exits.
 *
 * MSP has no read for three things Settings shows — configured marketplaces,
 * the plugins those marketplaces offer, and the skill catalog with each
 * skill's activation (`skill/list` returns only what the session can invoke)
 * — so those come from the same pinned binary's `--json` CLI reads. Every
 * change goes through MSP.
 */
import { execFile } from "node:child_process";
import type {
  CapabilityName,
  ComputerUseSettings,
  ComputerUseSetupState,
  FeedbackSubmitResult,
  HookListResult,
  PluginCatalogEntry,
  PluginInstallResult,
  PluginListResult,
  PluginMarketplaceRecordResult,
  PluginMarketplaceRemoveResult,
  SessionStartResult,
  SkillImportResult,
  SkillSetActivationResult,
} from "@muse-code/sdk/dist/src/msp.js";
import {
  describeMuseError,
  isMuseErrorKind,
  startMuseHost,
  type MuseHost,
  type MuseNotification,
} from "../chat/museSdkHost";
import { museCredentialEnv } from "./museAuth";
import { resolveMuseExecutable } from "./museExecutable";
import type { Logger } from "../logging/logger";
import type {
  MuseComputerUseSettings,
  MuseComputerUseSetup,
  MuseComputerUseState,
  MuseSettingsAvailablePlugin,
  MuseSettingsHook,
  MuseSettingsMarketplace,
  MuseSettingsPlugin,
  MuseSettingsRequest,
  MuseSettingsResult,
  MuseSettingsRunArgs,
  MuseSettingsSection,
  MuseSettingsSkill,
  MuseSettingsSnapshot,
} from "../../../shared/museSettings";

/** A page left open and untouched this long gives its host back. */
const IDLE_CLOSE_MS = 10 * 60_000;
/** More simultaneous Settings pages than this on one machine evict the oldest. */
const MAX_HOSTS = 3;
const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_FEEDBACK_NOTE_CHARS = 20_000;

/** Settings asks for Muse's own computer-use setup on top of the chat set. */
const SETTINGS_CAPABILITIES: CapabilityName[] = ["computerUseSetup", "computerUseHostSetup"];

type SettingsHost = {
  host: MuseHost;
  musePath: string;
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
  /** The scratch session per-session methods target; replaced after plugin changes. */
  sessionId: Promise<string> | null;
  /** The latest `computerUseSetup/changed` state Muse pushed for this host or its session. */
  pushedSetup: ComputerUseSetupState | null;
};

/** Keep the latest computer-use setup state Muse pushed (host-level or session-level). */
function takeSetupPush(state: SettingsHost, notification: MuseNotification): void {
  if (notification.method !== "computerUseSetup/changed") return;
  const pushed = asRecord(notification.params.state);
  if (typeof pushed.setup === "string") state.pushedSetup = pushed as unknown as ComputerUseSetupState;
}

type Entry = {
  key: string;
  started: Promise<SettingsHost>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
};

export type MuseSettingsServiceOptions = {
  workspaceRoot: string;
  clientVersion?: string;
  logger?: Pick<Logger, "info" | "warn" | "debug"> | null;
};

const entries = new Map<string, Entry>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const entry of entries.values()) {
      void entry.started.then((state) => state.host.close()).catch(() => undefined);
    }
  });
}

function requireText(value: unknown, label: string, maxLength = 4_096): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} is too long.`);
  return text;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
}

function stringList(value: unknown, label: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  return value.map((item) => requireText(item, label, 512));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runMuseJson(state: SettingsHost, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(
      state.musePath,
      args,
      { cwd: state.workspaceRoot, env: state.env, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        const text = String(stdout ?? "").trim();
        if (error && !text) {
          const detail = String(stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" ");
          reject(new Error(detail || error.message));
          return;
        }
        try {
          resolve(asRecord(JSON.parse(text)));
        } catch {
          reject(new Error(`muse ${args.slice(0, 3).join(" ")} did not answer with JSON.`));
        }
      },
    );
  });
}

async function section<T>(read: () => Promise<T[]>): Promise<MuseSettingsSection<T>> {
  try {
    return { ok: true, rows: await read() };
  } catch (error) {
    return { ok: false, error: describeMuseError(error) };
  }
}

function toPlugin(row: Pick<PluginCatalogEntry, "id" | "version" | "enabled" | "source">): MuseSettingsPlugin {
  return { id: row.id, version: row.version, enabled: row.enabled === true, source: String(row.source) };
}

function toMarketplaceFromCli(raw: unknown): MuseSettingsMarketplace {
  const row = asRecord(raw);
  const source = asRecord(row.source);
  return {
    name: str(row.name),
    sourceKind: str(source.kind),
    sourcePath: str(source.path),
    pluginCount: typeof row.plugin_count === "number" ? row.plugin_count : 0,
    skippedCount: Array.isArray(row.skipped) ? row.skipped.length : 0,
    lastUpdatedAt: str(row.last_updated_at) || null,
  };
}

function toMarketplaceFromMsp(result: PluginMarketplaceRecordResult): MuseSettingsMarketplace {
  return {
    name: result.name,
    sourceKind: result.source?.kind ?? "",
    sourcePath: result.source?.path ?? "",
    pluginCount: result.pluginCount,
    skippedCount: result.skipped?.length ?? 0,
    lastUpdatedAt: null,
  };
}

function toAvailablePlugin(raw: unknown): MuseSettingsAvailablePlugin {
  const row = asRecord(raw);
  return {
    marketplace: str(row.marketplace),
    name: str(row.name),
    version: str(row.version) || null,
    status: str(row.status) || "available",
  };
}

function toSkill(raw: unknown): MuseSettingsSkill {
  const row = asRecord(raw);
  const name = str(row.name);
  return {
    id: str(row.id),
    name,
    displayName: str(row.display_name) || name,
    description: str(row.short_description) || str(row.description),
    scope: str(row.scope),
    activation: str(row.activation) || "on",
  };
}

function toSetup(state: ComputerUseSetupState): MuseComputerUseSetup {
  return {
    setup: String(state.setup),
    accessibility: String(state.accessibility),
    screenRecording: String(state.screenRecording),
    inputMonitoring: String(state.inputMonitoring),
    message: state.message ?? null,
    refused: state.refused ?? null,
  };
}

function toComputerUseSettings(settings: ComputerUseSettings): MuseComputerUseSettings {
  return {
    computerControl: String(settings.computerControl),
    screenshots: String(settings.screenshots),
    blockedApps: (settings.blockedApps ?? []).map((app) => ({
      bundleId: app.bundleId,
      locked: app.locked === true,
      prefix: app.prefix === true,
    })),
  };
}

async function startSettingsHost(options: MuseSettingsServiceOptions): Promise<SettingsHost> {
  const baseEnv = { ...process.env };
  const env = { ...baseEnv, ...museCredentialEnv(baseEnv) };
  // Resolve, never fetch: a 350 MB download cannot ride a Settings action.
  // The page offers the download itself when the binary is missing.
  const musePath = resolveMuseExecutable({ env }).path;
  if (!musePath) throw new Error("Muse Code is not downloaded on this machine yet. Download it above, then try again.");
  const provider = process.env.ADE_MUSE_PROVIDER?.trim();
  const host = await startMuseHost({
    musePath,
    cwd: options.workspaceRoot,
    env,
    // Memory-only: the scratch session must not show up in `muse resume` or
    // in ADE's session import.
    serveArgs: ["--no-session-log", ...(provider ? ["--provider", provider] : [])],
    clientVersion: options.clientVersion ?? "ade",
    logger: options.logger ?? null,
    extraCapabilities: SETTINGS_CAPABILITIES,
  });
  const state: SettingsHost = {
    host,
    musePath,
    env,
    workspaceRoot: options.workspaceRoot,
    sessionId: null,
    pushedSetup: null,
  };
  host.onHostNotification((notification) => takeSetupPush(state, notification));
  return state;
}

function sessionFor(state: SettingsHost): Promise<string> {
  if (!state.sessionId) {
    const pending = state.host
      .command<SessionStartResult>("session/start", { workspaceRoot: state.workspaceRoot })
      .then((result) => {
        const id = result.session.sessionId;
        // Session-scoped pushes (plugin/changed, computerUseSetup/changed) go to
        // the session's subscribers, not the host's.
        state.host.subscribe(id, (notification) => takeSetupPush(state, notification));
        return id;
      });
    state.sessionId = pending;
    pending.catch(() => {
      if (state.sessionId === pending) state.sessionId = null;
    });
  }
  return state.sessionId;
}

async function readSnapshot(state: SettingsHost): Promise<MuseSettingsSnapshot> {
  const sessionId = sessionFor(state);
  const [plugins, hooks, marketplaces, availablePlugins, skills] = await Promise.all([
    section(async () => {
      const result = await state.host.request<PluginListResult>("plugin/list", { sessionId: await sessionId });
      return (result.plugins ?? []).map(toPlugin);
    }),
    section(async () => {
      const result = await state.host.request<HookListResult>("hook/list", { sessionId: await sessionId });
      return (result.hooks ?? []).map((row): MuseSettingsHook => ({
        key: row.key,
        event: String(row.event),
        handlerKind: String(row.handlerKind),
        enabled: row.enabled === true,
      }));
    }),
    section(async () => {
      const result = await runMuseJson(state, ["plugins", "marketplace", "list", "--json"]);
      return (Array.isArray(result.marketplaces) ? result.marketplaces : []).map(toMarketplaceFromCli);
    }),
    section(async () => {
      const result = await runMuseJson(state, ["plugins", "list", "--available", "--json"]);
      return (Array.isArray(result.available) ? result.available : []).map(toAvailablePlugin);
    }),
    section(async () => {
      const result = await runMuseJson(state, [
        "skills", "list", "--source", "all", "--json", "--workspace", state.workspaceRoot,
      ]);
      return (Array.isArray(result.skills) ? result.skills : []).map(toSkill).filter((skill) => skill.id);
    }),
  ]);
  return { workspaceRoot: state.workspaceRoot, plugins, marketplaces, availablePlugins, skills, hooks };
}

/**
 * The machine's own computer-use setup when the host granted
 * `computerUseHostSetup`, else the scratch session's. `computerUseUnavailable`
 * (Muse's computer-use gate is off on this host or account) is a state, not an
 * error: Settings shows Muse's sentence for it.
 */
async function readComputerUse(state: SettingsHost): Promise<MuseComputerUseState> {
  const hostSetup = state.host.grantedCapabilities.has("computerUseHostSetup");
  const setupParams = hostSetup ? {} : { sessionId: await sessionFor(state) };
  let settings: MuseComputerUseSettings | null = null;
  let settingsError: string | null = null;
  let setup: MuseComputerUseSetup | null = null;
  let setupError: string | null = null;
  try {
    settings = toComputerUseSettings(await state.host.request<ComputerUseSettings>("computerUseSettings/read", {}));
  } catch (error) {
    if (isMuseErrorKind(error, "computerUseUnavailable")) return { available: false, reason: describeMuseError(error) };
    settingsError = describeMuseError(error);
  }
  try {
    setup = toSetup(await state.host.request<ComputerUseSetupState>("computerUseSetup/read", setupParams));
  } catch (error) {
    if (isMuseErrorKind(error, "computerUseUnavailable")) return { available: false, reason: describeMuseError(error) };
    if (isMuseErrorKind(error, "capabilityRequired")) {
      setupError = "This Muse host did not grant computer-use setup to ADE.";
    } else {
      setupError = describeMuseError(error);
    }
    if (state.pushedSetup) setup = toSetup(state.pushedSetup);
  }
  return { available: true, settings, settingsError, setup, setupError, hostSetup };
}

async function run(state: SettingsHost, request: MuseSettingsRequest): Promise<MuseSettingsResult> {
  switch (request.kind) {
    case "snapshot":
      return await readSnapshot(state);
    case "computerUse":
      return await readComputerUse(state);
    case "pluginInstall": {
      const target = asRecord(request.target);
      const mspTarget = typeof target.path === "string"
        ? {
            localPath: {
              path: requireText(target.path, "Plugin folder"),
              ...(target.scope != null
                ? { scope: oneOf(target.scope, ["default", "user", "project"] as const, "Install scope") }
                : {}),
            },
          }
        : {
            marketplace: {
              marketplace: requireText(target.marketplace, "Marketplace"),
              name: requireText(target.name, "Plugin name"),
            },
          };
      const result = await state.host.command<PluginInstallResult>("plugin/install", {
        sessionId: await sessionFor(state),
        target: mspTarget,
      });
      // A new plugin's skills reach only sessions started after it; the next
      // read gets a fresh scratch session.
      state.sessionId = null;
      return { plugin: toPlugin(result), warning: result.warning ?? null };
    }
    case "marketplaceAdd": {
      const result = await state.host.command<PluginMarketplaceRecordResult>("plugin/marketplaceAdd", {
        sessionId: await sessionFor(state),
        name: requireText(request.name, "Marketplace name", 200),
        source: requireText(request.source, "Marketplace source"),
      });
      return { marketplace: toMarketplaceFromMsp(result) };
    }
    case "marketplaceUpdate": {
      const result = await state.host.command<PluginMarketplaceRecordResult>("plugin/marketplaceUpdate", {
        sessionId: await sessionFor(state),
        name: requireText(request.name, "Marketplace name", 200),
      });
      return { marketplace: toMarketplaceFromMsp(result) };
    }
    case "marketplaceRemove": {
      const result = await state.host.command<PluginMarketplaceRemoveResult>("plugin/marketplaceRemove", {
        sessionId: await sessionFor(state),
        name: requireText(request.name, "Marketplace name", 200),
      });
      return { name: result.name };
    }
    case "skillSetActivation": {
      const result = await state.host.command<SkillSetActivationResult>("skill/setActivation", {
        sessionId: await sessionFor(state),
        selector: requireText(request.selector, "Skill", 512),
        scope: oneOf(request.scope, ["user", "project", "bundled", "plugin"] as const, "Skill scope"),
        activation: oneOf(request.activation, ["on", "userInvocableOnly", "off"] as const, "Activation"),
      });
      state.sessionId = null;
      return { selector: result.selector, activation: String(result.activation), previous: String(result.previous) };
    }
    case "skillImport": {
      const result = await state.host.command<SkillImportResult>("skill/import", {
        sessionId: await sessionFor(state),
        source: oneOf(request.source, ["claude", "codex"] as const, "Import source"),
        dryRun: request.dryRun === true,
        ...(request.force === true ? { force: true } : {}),
      });
      if (!result.dryRun) state.sessionId = null;
      return {
        dryRun: result.dryRun,
        installed: result.installed ?? [],
        skipped: result.skipped ?? [],
        quarantined: (result.quarantined ?? []).map((row) => ({ id: row.id, reasons: row.reasons ?? [] })),
        failed: (result.failed ?? []).map((row) => ({ id: row.id ?? null, reason: row.reason })),
      };
    }
    case "computerUseUpdate": {
      const patch = asRecord(request.patch);
      const choices = ["ask", "alwaysAllow"] as const;
      await state.host.request<ComputerUseSettings>("computerUseSettings/update", {
        ...(patch.computerControl != null ? { computerControl: oneOf(patch.computerControl, choices, "Computer control") } : {}),
        ...(patch.screenshots != null ? { screenshots: oneOf(patch.screenshots, choices, "Screenshots") } : {}),
        ...(patch.blockApps != null ? { blockApps: stringList(patch.blockApps, "Blocked app") } : {}),
        ...(patch.unblockApps != null ? { unblockApps: stringList(patch.unblockApps, "Blocked app") } : {}),
      });
      return await readComputerUse(state);
    }
    case "computerUseSetupStart": {
      const hostSetup = state.host.grantedCapabilities.has("computerUseHostSetup");
      await state.host.command("computerUseSetup/start", hostSetup ? {} : { sessionId: await sessionFor(state) });
      return await readComputerUse(state);
    }
    case "computerUseSetupCheck": {
      if (!state.host.grantedCapabilities.has("computerUseHostSetup")) {
        throw new Error("This Muse host did not grant computer-use setup to ADE, so it cannot check permissions.");
      }
      const checked = await state.host.request<ComputerUseSetupState>("computerUseSetup/check", {});
      const current = await readComputerUse(state);
      if (!current.available) return current;
      return { ...current, setup: toSetup(checked), setupError: null };
    }
    case "feedback": {
      if (!state.host.grantedCapabilities.has("feedback")) {
        throw new Error("This Muse host does not accept feedback from ADE.");
      }
      const classification = oneOf(request.classification, ["bug", "badResult", "goodResult", "other"] as const, "Feedback type");
      const note = requireText(request.note, "Feedback", MAX_FEEDBACK_NOTE_CHARS);
      // No `sessionId`: the scratch session is not what the feedback is about,
      // so Muse files it in its host-level feedback folder.
      const result = await state.host.request<FeedbackSubmitResult>("feedback/submit", {
        classification,
        note,
        withFiles: request.withFiles === true,
      });
      return {
        outcome: String(result.outcome),
        bundlePath: result.bundlePath,
        cause: result.cause ?? null,
        retryAfterMs: result.retryAfterMs ?? null,
      };
    }
    default: {
      const unknown = (request as { kind?: unknown }).kind;
      throw new Error(`Unknown Muse settings request: ${String(unknown)}`);
    }
  }
}

function scheduleIdleClose(entry: Entry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    void closeMuseSettingsHost(entry.key);
  }, IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

function evictOldest(): void {
  while (entries.size >= MAX_HOSTS) {
    let oldest: Entry | null = null;
    for (const entry of entries.values()) {
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
    }
    if (!oldest) return;
    void closeMuseSettingsHost(oldest.key);
  }
}

async function hostFor(handleId: string, options: MuseSettingsServiceOptions): Promise<SettingsHost> {
  const key = `${options.workspaceRoot}\u0000${handleId}`;
  let entry = entries.get(key);
  if (entry) {
    const state = await entry.started.catch(() => null);
    if (!state || !state.host.alive) {
      entries.delete(key);
      entry = undefined;
    }
  }
  if (!entry) {
    evictOldest();
    installExitHook();
    const started = startSettingsHost(options);
    entry = { key, started, idleTimer: null, lastUsedAt: Date.now() };
    entries.set(key, entry);
    started.catch(() => {
      if (entries.get(key)?.started === started) entries.delete(key);
    });
  }
  entry.lastUsedAt = Date.now();
  scheduleIdleClose(entry);
  return await entry.started;
}

/** Run one Settings request on this machine's Settings host for `handleId`. */
export async function runMuseSettings(
  args: MuseSettingsRunArgs,
  options: MuseSettingsServiceOptions,
): Promise<MuseSettingsResult> {
  const handleId = requireText(args?.handleId, "handleId", 200);
  const request = asRecord(args?.request) as MuseSettingsRequest;
  const state = await hostFor(handleId, options);
  return await run(state, request);
}

/** Close the Settings host for `handleId` (every workspace), if one is open. */
export async function closeMuseSettingsHost(handleIdOrKey: string): Promise<void> {
  const matches = [...entries.values()].filter((entry) =>
    entry.key === handleIdOrKey || entry.key.endsWith(`\u0000${handleIdOrKey}`));
  for (const entry of matches) {
    entries.delete(entry.key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const state = await entry.started.catch(() => null);
    await state?.host.close().catch(() => undefined);
  }
}
