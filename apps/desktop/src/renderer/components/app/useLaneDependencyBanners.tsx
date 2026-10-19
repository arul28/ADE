import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Package, Stack } from "@phosphor-icons/react";
import type { LaneDependencyStatus, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { machineIdForBinding, machineNameForBinding } from "../../../shared/machineIdentity";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice/appBannerStore";
import { showToast } from "./toast/toastStore";
import { revealTerminalSessionInWork } from "../work/ClaudeLoginPromptButton";
import { useLaneTemplateSetupChat } from "../lanes/useLaneTemplateSetupChat";

/**
 * Two notices about the open project's main checkout, on the tab's machine:
 *
 * - **Packages are out of date** (docked): a lockfile no longer matches the
 *   install, usually after a pull. Update opens one terminal per folder in the
 *   main checkout that runs its install; ADE never installs on its own.
 * - **Set up a lane template** (floating prompt): the project has lockfiles and
 *   no default lane template, so new lanes start with no packages. Continue
 *   puts a setup prompt in a new chat in the main checkout.
 *
 * Both read `lane.getDependencyStatus`, which only stats files (and hashes a
 * lockfile when it changed). It runs a few seconds after the project opens, on
 * window focus at most every two minutes, and every ten minutes; while an
 * update the user started is running, every 15 s until it finishes.
 */

const FIRST_CHECK_DELAY_MS = 8_000;
const RECHECK_INTERVAL_MS = 10 * 60_000;
const FOCUS_RECHECK_MIN_MS = 2 * 60_000;
const UPDATE_WATCH_INTERVAL_MS = 15_000;
const UPDATE_WATCH_MAX_MS = 30 * 60_000;
const SUGGESTION_SNOOZE_MS = 14 * 24 * 3_600_000;
const SUGGESTION_STORAGE_KEY = "ade.laneTemplateSuggestion.v1";
const MAX_NAMED_FOLDERS = 3;

type SuggestionState = Record<string, number | "never">;

function readSuggestionState(): SuggestionState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SUGGESTION_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SuggestionState = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === "never" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function suggestionHidden(key: string, nowMs: number = Date.now()): boolean {
  const value = readSuggestionState()[key];
  return value === "never" || (typeof value === "number" && nowMs < value);
}

function hideSuggestion(key: string, until: number | "never"): void {
  try {
    const state = readSuggestionState();
    state[key] = until;
    window.localStorage.setItem(SUGGESTION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best effort — storage may be unavailable
  }
}

/** "apps/desktop and apps/ade-cli", "the root folder", "apps/web and 3 more". */
function describeFolders(dirs: string[]): string {
  const names = dirs.map((dir) => (dir === "." ? "the root folder" : dir));
  if (names.length <= MAX_NAMED_FOLDERS) {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, MAX_NAMED_FOLDERS).join(", ")} and ${names.length - MAX_NAMED_FOLDERS} more`;
}

export function useLaneDependencyBanners({
  projectRoot,
  projectBinding,
  lanes,
  enabled,
  navigate,
}: {
  projectRoot: string | null;
  projectBinding: OpenProjectBinding | null;
  lanes: LaneSummary[];
  /** Off while the welcome screen shows or no project is open. */
  enabled: boolean;
  navigate: (path: string) => void;
}): void {
  const [status, setStatus] = useState<LaneDependencyStatus | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);
  const [suggestionVersion, setSuggestionVersion] = useState(0);
  const lastCheckRef = useRef(0);
  const updatingRef = useRef(false);
  const machineName = machineNameForBinding(projectBinding);
  const scopeKey = projectRoot ? `${machineIdForBinding(projectBinding)}:${projectRoot}` : null;
  // The tab's own machine: unpinned calls reach it.
  const { start: startTemplateChat, busy: templateChatBusy } = useLaneTemplateSetupChat({ pin: null, machineName });

  // Bumped on every project switch, so an answer for the previous project is dropped.
  const generationRef = useRef(0);
  const check = useCallback(async (refresh = false) => {
    lastCheckRef.current = Date.now();
    const generation = generationRef.current;
    try {
      const next = await window.ade.lanes.getDependencyStatus({ refresh }, null);
      if (generation === generationRef.current) setStatus(next);
    } catch {
      // A runtime that predates the action, or a closed project: show nothing.
      if (generation === generationRef.current) setStatus(null);
    }
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    setStatus(null);
    setWatchUntil(0);
    if (!enabled || !scopeKey) return;
    let cancelled = false;
    const run = (refresh = false) => {
      if (!cancelled) void check(refresh);
    };
    const first = window.setTimeout(() => run(), FIRST_CHECK_DELAY_MS);
    const interval = window.setInterval(() => run(), RECHECK_INTERVAL_MS);
    const onFocus = () => {
      if (Date.now() - lastCheckRef.current >= FOCUS_RECHECK_MIN_MS) run(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [check, enabled, scopeKey]);

  const outOfDate = status?.folders.filter((folder) => folder.outOfDate) ?? [];
  const updating = watchUntil > 0;

  // While an update the user started runs, look again every 15 s until the
  // lockfiles read as installed (or the watch gives up).
  useEffect(() => {
    if (!updating) return;
    const timer = window.setInterval(() => {
      if (Date.now() > watchUntil) {
        setWatchUntil(0);
        return;
      }
      void check(true);
    }, UPDATE_WATCH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [check, updating, watchUntil]);

  useEffect(() => {
    if (!updating || !status || outOfDate.length > 0) return;
    setWatchUntil(0);
    showToast({ tone: "success", title: "Main checkout packages are up to date" });
  }, [outOfDate.length, status, updating]);

  const primaryLane = lanes.find((lane) => lane.laneType === "primary") ?? null;

  const runUpdate = useCallback(async () => {
    if (!status || !primaryLane || updatingRef.current) return;
    const folders = status.folders.filter((folder) => folder.outOfDate && folder.installCommand);
    if (!folders.length) return;
    updatingRef.current = true;
    try {
      // One terminal per folder, started in that folder: the install command
      // alone, so it runs the same in zsh, fish, PowerShell, cmd and Git Bash.
      let first: { terminalId: string; laneId: string } | null = null;
      for (const folder of folders) {
        const created = await window.ade.pty.create({
          laneId: primaryLane.id,
          ...(folder.dir === "." ? {} : { cwd: folder.dir }),
          cols: 100,
          rows: 28,
          title: folder.dir === "." ? "Update packages" : `Update packages · ${folder.dir}`,
          tracked: true,
          toolType: "shell",
          startupCommand: folder.installCommand!,
        });
        first ??= { terminalId: created.sessionId, laneId: primaryLane.id };
      }
      // Tools ADE cannot watch finish silently; count them as updated once
      // their installs have started (not before: a failed start keeps Update).
      const untracked = folders.filter((folder) => !folder.tracksInstall).map((folder) => folder.lockfile);
      if (untracked.length) {
        await window.ade.lanes.acknowledgeDependencyStatus({ lockfiles: untracked }, null).catch(() => null);
      }
      // Watch only installs that leave a record; the others cleared above.
      if (folders.some((folder) => folder.tracksInstall)) setWatchUntil(Date.now() + UPDATE_WATCH_MAX_MS);
      else void check(true);
      if (first) revealTerminalSessionInWork(navigate, first);
    } catch (error) {
      showToast({
        tone: "error",
        title: "Could not start the update",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      updatingRef.current = false;
    }
  }, [check, navigate, primaryLane, status]);

  const outOfDateDirs = outOfDate.map((folder) => folder.dir);
  useAppBanner(
    outOfDate.length > 0 && status
      ? {
          id: "lane-deps-out-of-date",
          tone: "info",
          icon: <Package size={13} weight="bold" />,
          busy: updating,
          title: updating ? "Updating packages in the main checkout…" : "Packages in the main checkout are out of date",
          detail: updating
            ? `The install runs in a terminal in Work. This goes away when ${describeFolders(outOfDateDirs)} ${outOfDateDirs.length === 1 ? "is" : "are"} installed.`
            : outOfDate.length === 1
              ? `${outOfDateDirs[0] === "." ? "The root folder" : outOfDateDirs[0]}: ${outOfDate[0]!.outOfDateReason ?? "the lockfile changed after the last install."}`
              : `${describeFolders(outOfDateDirs)} do not match their lockfiles. Update runs the installs in a terminal.`,
          actions: updating || !primaryLane || !outOfDate.some((folder) => folder.installCommand)
            ? []
            : [{ label: "Update", variant: "primary", onClick: () => void runUpdate() }],
          // A failed install would otherwise leave "Updating…" up for the whole watch.
          dismiss: { key: `lane-deps-out-of-date:${scopeKey}`, fingerprint: outOfDate.map((folder) => `${folder.lockfile}@${folder.fingerprint}`).join(",") },
        }
      : null,
    { placement: "docked", priority: APP_BANNER_PRIORITY.default },
  );

  const snoozeSuggestion = useCallback((until: number | "never") => {
    if (scopeKey) hideSuggestion(scopeKey, until);
    setSuggestionVersion((value) => value + 1);
  }, [scopeKey]);

  const suggestionSnoozed = useMemo(
    () => (scopeKey ? suggestionHidden(scopeKey) : true),
    // `suggestionVersion` re-reads storage after the user answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey, suggestionVersion, status],
  );
  const showSuggestion = Boolean(
    status
      && primaryLane
      && status.folders.length > 0
      && !status.defaultTemplateId
      && !suggestionSnoozed,
  );

  useAppBanner(
    showSuggestion
      ? {
          id: "lane-template-suggestion",
          tone: "accent",
          icon: <Stack size={13} weight="bold" />,
          busy: templateChatBusy,
          title: "Set up a lane template",
          detail: "New lanes start without packages. A template can install or copy them for each new lane, and an agent can set it up for you.",
          actions: [
            {
              label: "Set up with an agent",
              variant: "primary",
              onClick: () => {
                snoozeSuggestion(Date.now() + SUGGESTION_SNOOZE_MS);
                void startTemplateChat(status);
              },
            },
            { label: "Don't show again", variant: "link", onClick: () => snoozeSuggestion("never") },
          ],
          dismiss: { onDismiss: () => snoozeSuggestion(Date.now() + SUGGESTION_SNOOZE_MS), title: "Remind me in two weeks" },
        }
      : null,
    { placement: "floating", priority: APP_BANNER_PRIORITY.prompt },
  );
}
