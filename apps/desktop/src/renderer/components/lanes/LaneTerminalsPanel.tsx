import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, Grid, LayoutList, Plus, Settings, Trash2, X } from "lucide-react";
import { useAppStore } from "../../state/appStore";
import type { TerminalLaunchProfile, TerminalProfilesSnapshot, TerminalSessionSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { TerminalView } from "../terminals/TerminalView";
import { TilingLayout } from "./TilingLayout";
import { useNavigate } from "react-router-dom";

const tabTrigger =
  "flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-fg data-[state=active]:text-fg data-[state=active]:bg-accent/10 data-[state=active]:ring-1 data-[state=active]:ring-accent/50";

const LAUNCH_TRACKED_KEY = "ade.terminals.launchTracked";
const DEFAULT_PROFILE_IDS = ["claude", "codex", "shell"] as const;

const PROFILE_COLORS = [
  null, // no color / default
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
] as const;

function statusDot(status: string) {
  if (status === "running") return "bg-accent";
  if (status === "failed") return "bg-red-700";
  if (status === "disposed") return "bg-muted-fg";
  return "bg-border";
}

function sessionTabLabel(session: TerminalSessionSummary): string {
  const base = ((session.goal ?? "").trim() || session.title).trim() || "session";
  if (session.status === "running" && session.ptyId) return base;

  const tool = session.toolType ?? "shell";
  const outcome = session.exitCode != null ? `exit ${session.exitCode}` : session.status;
  const summary = (session.summary ?? "").trim();
  if (summary) return `${tool} · ${outcome} · ${summary}`.slice(0, 180);
  return `${tool} · ${outcome} · ${base}`.slice(0, 180);
}

function readLaunchTracked(): boolean {
  try {
    const raw = window.localStorage.getItem(LAUNCH_TRACKED_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    // ignore
  }
  return true;
}

function persistLaunchTracked(value: boolean) {
  try {
    window.localStorage.setItem(LAUNCH_TRACKED_KEY, value ? "1" : "0");
  } catch {
    // ignore
  }
}

function toolTypeFromProfileId(profileId: string): string | null {
  const id = profileId.trim().toLowerCase();
  if (id === "claude") return "claude";
  if (id === "codex") return "codex";
  if (id === "shell") return "shell";
  if (id === "aider") return "aider";
  if (id === "cursor") return "cursor";
  if (id === "continue") return "continue";
  return "other";
}

function isDefaultProfile(profile: TerminalLaunchProfile): boolean {
  return (DEFAULT_PROFILE_IDS as readonly string[]).includes(profile.id);
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueProfileId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 50; i += 1) {
    const next = `${base}-${i}`;
    if (!existing.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

export function LaneTerminalsPanel({ overrideLaneId }: { overrideLaneId?: string | null } = {}) {
  const navigate = useNavigate();
  const globalLaneId = useAppStore((s) => s.selectedLaneId);
  const laneId = overrideLaneId ?? globalLaneId;
  const globalFocusedSessionId = useAppStore((s) => s.focusedSessionId);
  const focusGlobalSession = useAppStore((s) => s.focusSession);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const lanes = useAppStore((s) => s.lanes);

  const laneName = useMemo(() => lanes.find((l) => l.id === laneId)?.name ?? null, [lanes, laneId]);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [viewMode, setViewMode] = useState<"tabs" | "grid">("tabs");
  const [closingSessionIds, setClosingSessionIds] = useState<Set<string>>(new Set());
  const [localFocusedSessionId, setLocalFocusedSessionId] = useState<string | null>(null);
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfilesSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchTracked, setLaunchTracked] = useState(readLaunchTracked());
  const [profileDraft, setProfileDraft] = useState<TerminalLaunchProfile[]>([]);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileCommand, setNewProfileCommand] = useState("");
  const [profilesBusy, setProfilesBusy] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const laneSessionIdsRef = useRef<Set<string>>(new Set());

  const focusedSessionId = overrideLaneId != null ? localFocusedSessionId : globalFocusedSessionId;
  const focusSession = useCallback(
    (sessionId: string | null) => {
      if (overrideLaneId != null) {
        setLocalFocusedSessionId(sessionId);
      } else {
        focusGlobalSession(sessionId);
      }
    },
    [overrideLaneId, focusGlobalSession]
  );

  const refresh = useCallback(async () => {
    if (!laneId) return;
    const rows = await window.ade.sessions.list({ laneId, limit: 80 });
    setSessions(rows);
    laneSessionIdsRef.current = new Set(rows.map((row) => row.id));
    if (rows.length > 0) {
      const runningOnly = rows.filter((s) => s.status === "running" && Boolean(s.ptyId));
      const visible = viewMode === "tabs" && runningOnly.length ? runningOnly : rows;
      const currentExists = focusedSessionId && visible.some((s) => s.id === focusedSessionId);
      if (!currentExists && viewMode === "tabs") {
        focusSession(visible[0]!.id);
      }
    } else {
      focusSession(null);
    }
  }, [laneId, focusedSessionId, viewMode, focusSession]);

  useEffect(() => {
    setSessions([]);
    setClosingSessionIds(new Set());
    laneSessionIdsRef.current = new Set();
    if (!laneId) return;
    refresh().catch(() => {});
  }, [laneId, overrideLaneId, refresh]);

  useEffect(() => {
    if (overrideLaneId == null) return;
    setLocalFocusedSessionId((current) => current ?? globalFocusedSessionId ?? null);
  }, [overrideLaneId, globalFocusedSessionId]);

  useEffect(() => {
    let cancelled = false;
    window.ade.terminalProfiles
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        setTerminalProfiles(snapshot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!laneId) return;
    const unsub = window.ade.pty.onExit((ev) => {
      if (!laneSessionIdsRef.current.has(ev.sessionId)) return;
      setClosingSessionIds((prev) => {
        if (!prev.has(ev.sessionId)) return prev;
        const next = new Set(prev);
        next.delete(ev.sessionId);
        return next;
      });
      refresh().catch(() => {});
      refreshLanes().catch(() => {});
    });
    return () => {
      try {
        unsub();
      } catch {}
    };
  }, [laneId, refresh, refreshLanes]);

  const closeSession = useCallback((session: TerminalSessionSummary) => {
    if (!session.ptyId) return;
    setClosingSessionIds((prev) => {
      if (prev.has(session.id)) return prev;
      const next = new Set(prev);
      next.add(session.id);
      return next;
    });
    setSessions((prev) =>
      prev.map((entry) =>
        entry.id === session.id
          ? { ...entry, ptyId: null, status: "disposed", endedAt: new Date().toISOString(), exitCode: null }
          : entry
      )
    );
    window.ade.pty.dispose({ ptyId: session.ptyId, sessionId: session.id })
      .then(() => {
        refresh().catch(() => {});
        refreshLanes().catch(() => {});
      })
      .catch(console.error)
      .finally(() => {
        setClosingSessionIds((prev) => {
          if (!prev.has(session.id)) return prev;
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        });
      });
  }, [focusSession, focusedSessionId, refresh, refreshLanes]);

  if (!laneId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-3">
        <EmptyState title="No lane selected" description="Select a lane to view its sessions." />
      </div>
    );
  }

  const runningSessions = useMemo(
    () => sessions.filter((s) => s.status === "running" && Boolean(s.ptyId)),
    [sessions]
  );
  const tabSessions = useMemo(() => {
    if (viewMode !== "tabs") return sessions;
    return runningSessions.length ? runningSessions : sessions;
  }, [sessions, viewMode, runningSessions]);

  const current = tabSessions.find((s) => s.id === focusedSessionId) ?? tabSessions[0] ?? null;

  const profileColorMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of terminalProfiles?.profiles ?? []) {
      if (p.color) m.set(p.id, p.color);
    }
    return m;
  }, [terminalProfiles]);

  const orderedProfiles = useMemo(() => {
    const profiles = terminalProfiles?.profiles ?? [];
    const byId = new Map(profiles.map((p) => [p.id, p] as const));
    const ordered: TerminalLaunchProfile[] = [];
    for (const id of DEFAULT_PROFILE_IDS) {
      const p = byId.get(id);
      if (p) ordered.push(p);
    }
    for (const p of profiles) {
      if ((DEFAULT_PROFILE_IDS as readonly string[]).includes(p.id)) continue;
      ordered.push(p);
    }
    return ordered.slice(0, 10);
  }, [terminalProfiles]);

  // Auto-refresh sessions every 5 seconds
  useEffect(() => {
    if (!laneId) return;
    const id = setInterval(() => {
      refresh().catch(() => {});
    }, 5_000);
    return () => clearInterval(id);
  }, [laneId, refresh]);

  const launchFromProfile = useCallback(
    (profile: TerminalLaunchProfile) => {
      if (!laneId) return;
      const title = profile.name || "Shell";
      const tracked = launchTracked;
      const initialCommand = (profile.command ?? "").trim();

      window.ade.pty
        .create({ laneId, cols: 100, rows: 30, title, tracked })
        .then(async ({ sessionId, ptyId }) => {
          focusSession(sessionId);
          refresh().catch(() => {});

          const toolType = toolTypeFromProfileId(profile.id);
          if (toolType) {
            window.ade.sessions.updateMeta({ sessionId, toolType }).catch(() => {});
          }

          if (initialCommand.length) {
            window.ade.pty.write({ ptyId, data: `${initialCommand}\r` }).catch(() => {});
          }
        })
        .catch(() => {});
    },
    [laneId, launchTracked, focusSession, refresh]
  );

  const openSettings = useCallback(() => {
    setProfilesError(null);
    setProfileDraft([...(terminalProfiles?.profiles ?? [])]);
    setSettingsOpen(true);
  }, [terminalProfiles]);

  const saveProfiles = useCallback(async () => {
    if (!terminalProfiles) return;
    setProfilesBusy(true);
    setProfilesError(null);
    try {
      const next = await window.ade.terminalProfiles.set({
        profiles: profileDraft,
        defaultProfileId: terminalProfiles.defaultProfileId ?? "shell"
      });
      setTerminalProfiles(next);
      setProfileDraft(next.profiles);
      setSettingsOpen(false);
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : String(err));
    } finally {
      setProfilesBusy(false);
    }
  }, [terminalProfiles, profileDraft]);

  const addProfile = useCallback(() => {
    const name = newProfileName.trim();
    const command = newProfileCommand.trim();
    if (!name || !command) {
      setProfilesError("Name and command are required.");
      return;
    }
    const existing = new Set(profileDraft.map((p) => p.id));
    const base = slugify(name) || "custom";
    const id = uniqueProfileId(base, existing);
    setProfileDraft((prev) => [...prev, { id, name, command, tracked: true, description: null, color: null }]);
    setNewProfileName("");
    setNewProfileCommand("");
    setProfilesError(null);
  }, [newProfileName, newProfileCommand, profileDraft]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <div className="flex items-center rounded border border-border bg-card/50 p-0.5">
            <button
              onClick={() => setViewMode("tabs")}
              className={cn("p-1 rounded hover:bg-muted", viewMode === "tabs" && "bg-muted text-fg shadow-sm")}
              title="Tab View"
            >
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={cn("p-1 rounded hover:bg-muted", viewMode === "grid" && "bg-muted text-fg shadow-sm")}
              title="Tiling Grid"
            >
              <Grid className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="truncate text-xs font-semibold">{laneName ?? laneId}</div>
          <Chip className="text-[10px]">{runningSessions.length} running</Chip>
          {!launchTracked ? <Chip className="text-[10px]">no context</Chip> : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {orderedProfiles
              .filter((p) => (DEFAULT_PROFILE_IDS as readonly string[]).includes(p.id))
              .map((profile) => (
                <Button
                  key={profile.id}
                  variant={profile.id === "shell" ? "outline" : "primary"}
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  style={profile.color ? { backgroundColor: profile.color, borderColor: profile.color, color: "#fff" } : undefined}
                  onClick={() => launchFromProfile(profile)}
                  title={profile.command ? `${profile.name} (${profile.command})` : profile.name}
                >
                  {profile.color ? <span className="h-2 w-2 rounded-full bg-white/40" /> : null}
                  {profile.name}
                </Button>
              ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            title="Open in Terminals tab"
            onClick={() => {
              navigate(`/terminals?laneId=${encodeURIComponent(laneId)}&status=running`);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Terminals
          </Button>
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" title="Terminal settings" onClick={openSettings}>
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <EmptyState title="No sessions yet" description="Start a terminal session for this lane." />
        </div>
      ) : viewMode === "tabs" ? (
        <Tabs.Root
          value={current?.id ?? ""}
          onValueChange={(v) => focusSession(v)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs.List className="flex flex-wrap gap-1 rounded-lg border border-border bg-card/60 p-1">
            {tabSessions.map((s) => {
              const profileColor = s.toolType ? profileColorMap.get(s.toolType) : undefined;
              return (
              <Tabs.Trigger key={s.id} className={cn(tabTrigger)} value={s.id}>
                <span
                  className={cn("h-2 w-2 rounded-full", !profileColor && statusDot(s.status))}
                  style={profileColor ? { backgroundColor: profileColor } : undefined}
                />
                <span className="max-w-[260px] truncate">{sessionTabLabel(s)}</span>
                {!s.tracked ? <span className="rounded border border-border px-1 text-[10px] text-muted-fg">no ctx</span> : null}
                {s.status === "running" && s.ptyId ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "ml-1 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted/60",
                      closingSessionIds.has(s.id) && "opacity-50 pointer-events-none"
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      closeSession(s);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        closeSession(s);
                      }
                    }}
                    title={closingSessionIds.has(s.id) ? "Closing…" : "Close / kill session"}
                  >
                    <X className="h-3 w-3" />
                  </span>
                ) : null}
              </Tabs.Trigger>
              );
            })}
          </Tabs.List>

          <div className="mt-2 min-h-0 flex-1 relative">
            {/* Render a header for the current running session */}
            {current && current.status === "running" && current.ptyId ? (
              <div className="flex items-center justify-between gap-2 rounded border border-border bg-card/50 px-2 py-1 mb-2 shrink-0">
                <div className="min-w-0 flex items-center gap-2">
                  <div className="truncate text-xs font-semibold text-fg">{current.title}</div>
                  {current.toolType ? <Chip className="text-[10px]">{current.toolType}</Chip> : null}
                  {!current.tracked ? <Chip className="text-[10px]">no context</Chip> : null}
                </div>
                <div className="shrink-0 text-[11px] text-muted-fg">{new Date(current.startedAt).toLocaleString()}</div>
              </div>
            ) : null}

            {/* All running terminals rendered simultaneously, only active one visible */}
            <div className="flex-1 min-h-0 relative" style={{ height: 'calc(100% - 40px)' }}>
              {tabSessions.filter(s => s.status === "running" && s.ptyId).map(s => (
                <div key={s.id} className={cn("absolute inset-0", s.id !== current?.id && "invisible pointer-events-none")}>
                  <TerminalView ptyId={s.ptyId!} sessionId={s.id} className="h-full" />
                </div>
              ))}
            </div>

          </div>
        </Tabs.Root>
      ) : (
        /* TILE MODE */
        <div className="min-h-0 flex-1 border border-border bg-black/20 rounded-lg overflow-hidden">
          <TilingLayout
            sessions={sessions.filter((s) => s.status === "running" && Boolean(s.ptyId))}
            focusedSessionId={focusedSessionId}
            onFocus={focusSession}
            onClose={(id) => {
              const s = sessions.find((x) => x.id === id);
              if (s) closeSession(s);
            }}
            closingSessionIds={closingSessionIds}
          />
        </div>
      )}

      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[12%] z-50 w-[min(880px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border bg-card p-4 shadow-2xl focus:outline-none">
            <div className="mb-3 flex items-center justify-between gap-3">
              <Dialog.Title className="text-sm font-semibold">Terminal Settings</Dialog.Title>
              <Dialog.Description className="sr-only">
                Configure launch profiles and whether new terminals collect context.
              </Dialog.Description>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>

            <div className="space-y-3">
              <div className="rounded border border-border bg-bg/40 p-3 text-xs">
                <div className="text-[11px] font-semibold text-muted-fg">Launch mode</div>
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={launchTracked}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setLaunchTracked(next);
                      persistLaunchTracked(next);
                    }}
                  />
                  <span className="text-fg">Launch terminals with context (tracked transcripts + pack refresh)</span>
                </label>
                <div className="mt-1 text-[11px] text-muted-fg">
                  If disabled, terminals still run normally but do not produce transcripts or pack updates.
                </div>
              </div>

              <div className="rounded border border-border bg-bg/40 p-3 text-xs">
                <div className="text-[11px] font-semibold text-muted-fg">Terminal buttons</div>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  {profileDraft.length === 0 ? (
                    <div className="text-[11px] text-muted-fg">No profiles loaded.</div>
                  ) : (
                    profileDraft.map((p) => {
                      const locked = isDefaultProfile(p);
                      return (
                        <div key={p.id} className="rounded border border-border bg-card/50 p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="min-w-[140px] text-[11px] text-muted-fg">{p.id}</div>
                            <input
                              className="h-8 flex-1 min-w-[180px] rounded border border-border bg-bg/40 px-2 text-xs text-fg outline-none"
                              value={p.name}
                              onChange={(e) =>
                                setProfileDraft((prev) => prev.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))
                              }
                              placeholder="Name"
                            />
                            <input
                              className="h-8 flex-[2] min-w-[220px] rounded border border-border bg-bg/40 px-2 text-xs text-fg font-mono outline-none"
                              value={p.command}
                              onChange={(e) =>
                                setProfileDraft((prev) => prev.map((x) => (x.id === p.id ? { ...x, command: e.target.value } : x)))
                              }
                              placeholder="Command"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2 text-[11px]"
                              disabled={locked}
                              onClick={() => setProfileDraft((prev) => prev.filter((x) => x.id !== p.id))}
                              title={locked ? "Default buttons cannot be removed" : "Remove button"}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="mt-1.5 flex items-center gap-1">
                            <span className="text-[10px] text-muted-fg mr-1">Color</span>
                            {PROFILE_COLORS.map((c) => (
                              <button
                                key={c ?? "none"}
                                type="button"
                                className={cn(
                                  "h-5 w-5 rounded-full border-2 transition-transform hover:scale-110",
                                  (p.color ?? null) === c ? "border-fg scale-110" : "border-transparent"
                                )}
                                style={{ backgroundColor: c ?? "transparent" }}
                                onClick={() =>
                                  setProfileDraft((prev) => prev.map((x) => (x.id === p.id ? { ...x, color: c } : x)))
                                }
                                title={c ?? "Default (no color)"}
                              >
                                {c == null ? <X className="h-3 w-3 mx-auto text-muted-fg" /> : null}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="mt-3 rounded border border-border bg-bg/40 p-2">
                  <div className="text-[11px] font-semibold text-muted-fg">Add custom button</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      className="h-8 min-w-[180px] flex-1 rounded border border-border bg-bg/40 px-2 text-xs text-fg outline-none"
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      placeholder="Name (e.g., Dev Server)"
                    />
                    <input
                      className="h-8 min-w-[220px] flex-[2] rounded border border-border bg-bg/40 px-2 text-xs text-fg font-mono outline-none"
                      value={newProfileCommand}
                      onChange={(e) => setNewProfileCommand(e.target.value)}
                      placeholder="Command (e.g., npm run dev)"
                    />
                    <Button size="sm" variant="primary" className="h-8 px-2 text-[11px]" onClick={addProfile}>
                      <Plus className="mr-1 h-3 w-3" />
                      Add
                    </Button>
                  </div>
                </div>

                {profilesError ? (
                  <div className="mt-2 rounded border border-red-900 bg-red-950/20 p-2 text-[11px] text-red-300">
                    {profilesError}
                  </div>
                ) : null}

                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSettingsOpen(false)} disabled={profilesBusy}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void saveProfiles()} disabled={profilesBusy}>
                    {profilesBusy ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
