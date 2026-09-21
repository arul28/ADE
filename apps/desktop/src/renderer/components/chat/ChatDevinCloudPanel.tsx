import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Desktop,
} from "@phosphor-icons/react";

import type {
  DevinCloudFleetEntry,
  DevinCloudFleetStatus,
  DevinCloudMode,
  DevinCloudOpenChatResult,
} from "../../../shared/types";
import { navigateUrlInAdeBrowser, openExternalUrl } from "../../lib/openExternal";
import {
  devinCloudErrorMessage,
  devinCloudModeLabel,
  devinCloudRepoLabel,
  devinCloudStatusToneClass,
  formatDevinCloudAge,
  repoMatchKey,
} from "../../lib/devinCloudUtils";
import { cn } from "../ui/cn";
import { DevinLogo } from "../shared/ProviderLogos";
import { SmartTooltip } from "../ui/SmartTooltip";

const TERMINAL_STATUSES: ReadonlySet<DevinCloudFleetStatus> = new Set([
  "finished",
  "error",
  "archived",
]);

function isActiveStatus(status: DevinCloudFleetStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
}

export const DEVIN_CLOUD_MODES: readonly DevinCloudMode[] = [
  "normal",
  "fast",
  "lite",
  "ultra",
  "fusion",
];

export type ChatDevinCloudPanelHandle = {
  launchWithPrompt: (promptText: string) => Promise<{ devinSessionId: string } | null>;
  hasRequiredFields: () => boolean;
};

type ChatDevinCloudPanelProps = {
  devinSessionId: string | null;
  laneId: string | null;
  laneGitRemote?: string | null;
  laneGitBranch?: string | null;
  devinMode: DevinCloudMode | null;
  onDevinModeChange: (mode: DevinCloudMode | null) => void;
  /** VM platform label (v3, org-defined e.g. linux/macos/windows/outpost). */
  platform: string;
  onPlatformChange: (value: string) => void;
  bypassApproval: boolean;
  onBypassApprovalChange: (value: boolean) => void;
  onLaunched?: (devinSessionId: string) => void;
  onClose: () => void;
  onOpened?: (result: DevinCloudOpenChatResult) => void;
  onMissingFields?: (message: string) => void;
};

/**
 * Right-pane Devin Cloud surface: session settings for the next launch plus
 * the org sessions that touch this lane's repo. Unlike Cursor, Devin binds a
 * session to any repo URL at create time — there is no account repo list to
 * pick from, so the target is the lane's own remote shown as the launch
 * context it is.
 */
export const ChatDevinCloudPanel = forwardRef<ChatDevinCloudPanelHandle, ChatDevinCloudPanelProps>(function ChatDevinCloudPanel({
  devinSessionId,
  laneId,
  laneGitRemote,
  laneGitBranch,
  devinMode,
  onDevinModeChange,
  platform,
  onPlatformChange,
  bypassApproval,
  onBypassApprovalChange,
  onLaunched,
  onClose,
  onOpened,
  onMissingFields,
}, ref) {
  const [entries, setEntries] = useState<DevinCloudFleetEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const repoKey = useMemo(() => (laneGitRemote ? repoMatchKey(laneGitRemote) : null), [laneGitRemote]);

  const refresh = useCallback(async (opts?: { soft?: boolean }) => {
    if (opts?.soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await window.ade.ai.devinCloudFleet({});
      setEntries(result.items);
    } catch (err) {
      setError(devinCloudErrorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refreshRef.current();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshRef.current({ soft: true });
    }, 15_000);
    return () => window.clearInterval(interval);
  }, []);

  /** Sessions touching this lane's repo — the fleet already covers the org. */
  const repoEntries = useMemo(() => {
    if (!repoKey) return entries;
    return entries.filter((entry) =>
      entry.session.repos.some((repo) => repoMatchKey(repo) === repoKey),
    );
  }, [entries, repoKey]);

  const sessionEntry = useMemo(() => {
    if (!devinSessionId) return null;
    return entries.find((entry) => entry.session.sessionId === devinSessionId) ?? null;
  }, [devinSessionId, entries]);

  const activeEntries = useMemo(
    () => repoEntries.filter((entry) => isActiveStatus(entry.fleetStatus)),
    [repoEntries],
  );
  const recentEntries = useMemo(
    () => repoEntries
      .filter((entry) => !isActiveStatus(entry.fleetStatus))
      .filter((entry) => entry.session.sessionId !== devinSessionId)
      .slice(0, 6),
    [devinSessionId, repoEntries],
  );

  const launchWithPrompt = useCallback(async (rawPrompt: string): Promise<{ devinSessionId: string } | null> => {
    const trimmedPrompt = rawPrompt.trim();
    if (!trimmedPrompt) {
      onMissingFields?.("Type a prompt in the chat composer first.");
      return null;
    }
    if (!laneId) {
      onMissingFields?.("Choose a lane before sending work to Devin Cloud.");
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const created = await window.ade.ai.devinCloudCreateSession({
        laneId,
        prompt: trimmedPrompt,
        devinMode,
        bypassApproval,
        platform: platform.trim() || null,
      });
      onLaunched?.(created.devinSessionId);
      onOpened?.({ sessionId: created.sessionId, session: created.session });
      await refresh({ soft: true });
      return { devinSessionId: created.devinSessionId };
    } catch (err) {
      setError(devinCloudErrorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [bypassApproval, devinMode, laneId, onLaunched, onMissingFields, onOpened, platform, refresh]);

  useImperativeHandle(ref, () => ({
    launchWithPrompt,
    hasRequiredFields: () => Boolean(laneId && laneGitRemote?.trim()),
  }), [laneId, laneGitRemote, launchWithPrompt]);

  const openChat = useCallback(async (targetDevinSessionId: string) => {
    if (!laneId) {
      setError("Open a lane to open this cloud chat.");
      return;
    }
    setBusySessionId(targetDevinSessionId);
    setError(null);
    try {
      const result = await window.ade.ai.devinCloudOpenChat({
        devinSessionId: targetDevinSessionId,
        laneId,
      });
      // Only close the panel after we've handed the new session id to the
      // parent. If onClose ran first (or unconditionally) the panel would
      // unmount before onOpened could navigate, leaving the user on the
      // previous chat with no visible feedback.
      onOpened?.(result);
      onClose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[devin-cloud] openChat failed", err);
      setError(devinCloudErrorMessage(err));
    } finally {
      setBusySessionId(null);
    }
  }, [laneId, onClose, onOpened]);

  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <DevinLogo size={14} className="rounded-[3px]" />
          <span className="font-sans text-[12px] font-medium text-fg/80">Devin Cloud sessions</span>
          {refreshing ? (
            <ArrowsClockwise size={10} weight="bold" className="animate-spin text-fg/30" />
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void refresh({ soft: true })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.025] text-fg/45 transition-colors hover:border-white/[0.10] hover:text-fg/75"
            title="Refresh"
            aria-label="Refresh Devin Cloud panel"
            disabled={loading || refreshing}
          >
            <ArrowsClockwise size={12} weight="bold" />
          </button>
          <button
            type="button"
            className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 font-sans text-[10px] font-medium text-fg/50 transition-colors hover:text-fg/80"
            onClick={onClose}
            title="Close Devin Cloud panel"
            aria-label="Close Devin Cloud panel"
          >
            Close
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="border-b border-red-500/15 bg-red-500/[0.05] px-4 py-2 font-sans text-[11px] leading-5 text-red-200/85">
            {error.includes("Devin API token") || error.includes("DEVIN_API_KEY")
              ? "Add a Devin API token in Settings → AI providers."
              : error}
          </div>
        ) : null}

        <div className="space-y-4 px-4 py-3">
          {/* Launch settings for the next send */}
          <section>
            <SectionLabel>New session</SectionLabel>
            <div className="mt-2 space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="font-sans text-[10.5px] text-fg/45">Target repo</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-fg/70">
                  {laneGitRemote ? devinCloudRepoLabel(laneGitRemote) : "No GitHub remote"}
                </span>
              </div>
              {laneGitBranch ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="font-sans text-[10.5px] text-fg/45">Base branch</span>
                  <span className="min-w-0 truncate font-mono text-[10.5px] text-fg/70">{laneGitBranch}</span>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <span className="font-sans text-[10.5px] text-fg/45">Agent mode</span>
                <select
                  value={devinMode ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    onDevinModeChange((DEVIN_CLOUD_MODES as readonly string[]).includes(value) ? value as DevinCloudMode : null);
                  }}
                  aria-label="Devin agent mode"
                  className="h-6 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[10.5px] text-fg/75 outline-none hover:border-white/[0.16]"
                >
                  <option value="">Devin default</option>
                  {DEVIN_CLOUD_MODES.map((mode) => (
                    <option key={mode} value={mode}>{devinCloudModeLabel(mode)}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-sans text-[10.5px] text-fg/45">VM platform</span>
                <input
                  type="text"
                  list="ade-devin-cloud-platforms"
                  value={platform}
                  onChange={(event) => onPlatformChange(event.target.value)}
                  placeholder="org default"
                  aria-label="Devin VM platform"
                  className="h-6 w-36 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-right font-mono text-[10.5px] text-fg/75 outline-none placeholder:text-fg/30 hover:border-white/[0.16]"
                />
                <datalist id="ade-devin-cloud-platforms">
                  <option value="linux" />
                  <option value="macos" />
                  <option value="windows" />
                </datalist>
              </div>
              <label className="flex items-center justify-between gap-3">
                <span className="font-sans text-[10.5px] text-fg/45">
                  Skip Devin's approval gate
                </span>
                <input
                  type="checkbox"
                  checked={bypassApproval}
                  onChange={(event) => onBypassApprovalChange(event.target.checked)}
                  className="h-3 w-3 accent-sky-400"
                  aria-label="Bypass Devin approval"
                />
              </label>
              <div className="pt-0.5 font-sans text-[10px] leading-relaxed text-fg/35">
                Send in the composer launches a Devin cloud session tagged to this lane.
              </div>
            </div>
          </section>

          {/* Linked session */}
          {sessionEntry ? (
            <section>
              <SectionLabel>This chat's session</SectionLabel>
              <div className="mt-2">
                <DevinSessionRow
                  entry={sessionEntry}
                  busy={busySessionId === sessionEntry.session.sessionId}
                  onOpenLive={() => {
                    const url = sessionEntry.session.url?.trim();
                    if (url) navigateUrlInAdeBrowser(url, { newTab: true });
                  }}
                />
              </div>
            </section>
          ) : null}

          {/* Active */}
          {activeEntries.filter((entry) => entry.session.sessionId !== devinSessionId).length > 0 ? (
            <section>
              <SectionLabel>Running in this repo</SectionLabel>
              <div className="mt-2 space-y-1.5">
                {activeEntries
                  .filter((entry) => entry.session.sessionId !== devinSessionId)
                  .map((entry) => (
                    <DevinSessionRow
                      key={entry.session.sessionId}
                      entry={entry}
                      busy={busySessionId === entry.session.sessionId}
                      onOpen={() => void openChat(entry.session.sessionId)}
                      onOpenLive={() => {
                        const url = entry.session.url?.trim();
                        if (url) navigateUrlInAdeBrowser(url, { newTab: true });
                      }}
                    />
                  ))}
              </div>
            </section>
          ) : null}

          {/* Recent */}
          <section>
            <SectionLabel>Recent in this repo</SectionLabel>
            <div className="mt-2 space-y-1.5">
              {loading && entries.length === 0 ? (
                <div className="rounded-md border border-white/[0.05] bg-white/[0.015] px-3 py-3 text-center font-sans text-[11px] text-fg/35">
                  Loading…
                </div>
              ) : recentEntries.length === 0 ? (
                <div className="rounded-md border border-white/[0.05] bg-white/[0.015] px-3 py-3 text-center font-sans text-[11px] text-fg/35">
                  {repoKey ? "No Devin sessions on this repo yet." : "No Devin sessions yet."}
                </div>
              ) : recentEntries.map((entry) => (
                <DevinSessionRow
                  key={entry.session.sessionId}
                  entry={entry}
                  busy={busySessionId === entry.session.sessionId}
                  onOpen={entry.session.isArchived ? undefined : () => void openChat(entry.session.sessionId)}
                  onOpenLive={() => {
                    const url = entry.session.url?.trim();
                    if (url) navigateUrlInAdeBrowser(url, { newTab: true });
                  }}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
});

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-sans text-[10px] font-semibold uppercase tracking-[1px] text-fg/40">
      {children}
    </div>
  );
}

function DevinSessionRow({
  entry,
  busy,
  onOpen,
  onOpenLive,
}: {
  entry: DevinCloudFleetEntry;
  busy: boolean;
  onOpen?: () => void;
  onOpenLive?: () => void;
}) {
  const { session } = entry;
  const age = formatDevinCloudAge(session.updatedAt ?? session.createdAt);
  const webUrl = session.url?.trim() || null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate font-sans text-[11.5px] font-medium text-fg/80">
            {session.title || session.sessionId.slice(0, 12)}
          </span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-full border px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-[0.8px]",
              devinCloudStatusToneClass(entry.fleetStatus),
            )}
          >
            {entry.fleetStatus === "needs_you" ? "needs you" : entry.fleetStatus}
          </span>
          {age ? <span className="shrink-0 font-mono text-[9.5px] text-fg/30">{age}</span> : null}
        </span>
      </span>
      {onOpenLive && webUrl ? (
        <SmartTooltip
          forceEnabled
          content={{ label: "Live view", description: "Open the session — incl. its live Desktop — in ADE's browser." }}
        >
          <button
            type="button"
            onClick={onOpenLive}
            disabled={busy}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/[0.07] text-fg/45 transition-colors hover:border-white/[0.14] hover:text-fg/80 disabled:opacity-40"
            aria-label="Open live session in ADE browser"
          >
            <Desktop size={11} weight="bold" />
          </button>
        </SmartTooltip>
      ) : null}
      {webUrl ? (
        <button
          type="button"
          onClick={() => openExternalUrl(webUrl)}
          disabled={busy}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/[0.07] text-fg/45 transition-colors hover:border-white/[0.14] hover:text-fg/80 disabled:opacity-40"
          title="Open on app.devin.ai"
          aria-label="Open session on app.devin.ai"
        >
          <ArrowSquareOut size={11} weight="bold" />
        </button>
      ) : null}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="inline-flex h-6 items-center rounded-md border border-sky-300/25 bg-sky-500/[0.10] px-2 font-sans text-[10px] font-semibold text-sky-100/90 transition-colors hover:border-sky-300/40 hover:bg-sky-500/[0.18] disabled:opacity-40"
          title="Open as an ADE cloud chat"
        >
          {busy ? "Opening…" : "Open"}
        </button>
      ) : null}
    </div>
  );
}
