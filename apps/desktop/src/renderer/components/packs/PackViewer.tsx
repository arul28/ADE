import React, { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { BookOpen, RefreshCw } from "lucide-react";
import type { PackEvent, PackSummary, PackVersionSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { PackFreshnessIndicator } from "./PackFreshnessIndicator";

function PackBody({ pack }: { pack: PackSummary | null }) {
  if (!pack) {
    return <div className="text-xs text-muted-fg">Loading pack…</div>;
  }
  if (!pack.exists || !pack.body.trim().length) {
    return <div className="text-xs text-muted-fg">Pack file not created yet.</div>;
  }
  return (
    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded border border-border bg-card/70 p-3 text-[11px] leading-relaxed">
      {pack.body}
    </pre>
  );
}

function extractNarrative(body: string): string {
  const marker = "\n## Narrative\n";
  const idx = body.indexOf(marker);
  if (idx < 0) return "";
  return body.slice(idx + marker.length).trim();
}

export function PackViewer({ laneId }: { laneId: string | null }) {
  const [lanePack, setLanePack] = useState<PackSummary | null>(null);
  const [projectPack, setProjectPack] = useState<PackSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [narrativeBusy, setNarrativeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [narrativeDraft, setNarrativeDraft] = useState("");
  const [versionsDialogOpen, setVersionsDialogOpen] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versions, setVersions] = useState<PackVersionSummary[]>([]);
  const [fromVersionId, setFromVersionId] = useState<string | null>(null);
  const [toVersionId, setToVersionId] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [eventsDialogOpen, setEventsDialogOpen] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [events, setEvents] = useState<PackEvent[]>([]);

  const refreshLanePack = async () => {
    if (!laneId) return;
    setLoading(true);
    setError(null);
    try {
      const pack = await window.ade.packs.refreshLanePack(laneId);
      setLanePack(pack);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const generateNarrative = async () => {
    if (!laneId) return;
    setNarrativeBusy(true);
    setError(null);
    try {
      const pack = await window.ade.packs.generateNarrative(laneId);
      setLanePack(pack);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNarrativeBusy(false);
    }
  };

  const openEditNarrative = () => {
    setError(null);
    setNarrativeDraft(lanePack?.body ? extractNarrative(lanePack.body) : "");
    setEditDialogOpen(true);
  };

  const saveNarrative = async () => {
    if (!lanePack?.packKey) return;
    setNarrativeBusy(true);
    setError(null);
    try {
      const updated = await window.ade.packs.updateNarrative({ packKey: lanePack.packKey, narrative: narrativeDraft });
      setLanePack(updated);
      setEditDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNarrativeBusy(false);
    }
  };

  const openVersions = async () => {
    if (!lanePack?.packKey) return;
    setVersionsDialogOpen(true);
    setVersionsLoading(true);
    setDiffText(null);
    setError(null);
    try {
      const list = await window.ade.packs.listVersions({ packKey: lanePack.packKey, limit: 60 });
      setVersions(list);
      setFromVersionId(list[1]?.id ?? list[0]?.id ?? null);
      setToVersionId(list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  };

  const runDiff = async () => {
    if (!fromVersionId || !toVersionId) return;
    if (fromVersionId === toVersionId) return;
    setDiffBusy(true);
    setError(null);
    try {
      const out = await window.ade.packs.diffVersions({ fromId: fromVersionId, toId: toVersionId });
      setDiffText(out.trim().length ? out : "(no diff)");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffBusy(false);
    }
  };

  const openEvents = async () => {
    if (!lanePack?.packKey) return;
    setEventsDialogOpen(true);
    setEventsLoading(true);
    setError(null);
    try {
      const list = await window.ade.packs.listEvents({ packKey: lanePack.packKey, limit: 80 });
      setEvents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  };

  useEffect(() => {
    setLanePack(null);
    setError(null);
    if (!laneId) return;

    let cancelled = false;
    window.ade.packs
      .getLanePack(laneId)
      .then((pack) => {
        if (cancelled) return;
        setLanePack(pack);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [laneId]);

  useEffect(() => {
    let cancelled = false;
    window.ade.packs
      .getProjectPack()
      .then((pack) => {
        if (!cancelled) setProjectPack(pack);
      })
      .catch(() => {
        if (!cancelled) setProjectPack(null);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId]);

  if (!laneId) {
    return <EmptyState title="No lane selected" description="Select a lane to view its deterministic pack." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <PackFreshnessIndicator
          deterministicUpdatedAt={lanePack?.deterministicUpdatedAt ?? null}
          narrativeUpdatedAt={lanePack?.narrativeUpdatedAt ?? null}
        />
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" title="Refresh lane pack" onClick={() => refreshLanePack().catch(() => {})}>
            <RefreshCw className="h-4 w-4" />
            {loading ? "Refreshing" : "Refresh"}
          </Button>
          <Button variant="outline" size="sm" disabled={!lanePack?.packKey} onClick={() => void openEvents()}>
            Events
          </Button>
          <Button variant="outline" size="sm" disabled={!lanePack?.packKey} onClick={openEditNarrative}>
            Edit Narrative
          </Button>
          <Button variant="outline" size="sm" disabled={!lanePack?.packKey} onClick={() => void openVersions()}>
            Versions
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={narrativeBusy}
            title="Generate AI narrative for lane pack"
            onClick={() => generateNarrative().catch(() => {})}
          >
            {narrativeBusy ? "Generating…" : "Generate AI Summary"}
          </Button>
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <Button variant="outline" size="sm">
                <BookOpen className="h-4 w-4" />
                Project Pack
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
              <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(980px,calc(100vw-24px))] -translate-x-1/2 rounded-sm border border-border bg-bg p-4 shadow-2xl focus:outline-none">
                <div className="mb-3 flex items-center justify-between">
                  <Dialog.Title className="text-sm font-semibold">Project Pack</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm">
                      Close
                    </Button>
                  </Dialog.Close>
                </div>
                <PackFreshnessIndicator
                  deterministicUpdatedAt={projectPack?.deterministicUpdatedAt ?? null}
                  narrativeUpdatedAt={projectPack?.narrativeUpdatedAt ?? null}
                />
                <div className="mt-3">
                  <PackBody pack={projectPack} />
                </div>
                {projectPack?.path ? (
                  <div className="mt-2 truncate text-[11px] text-muted-fg">{projectPack.path}</div>
                ) : null}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {error ? <div className="rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">{error}</div> : null}

      <PackBody pack={lanePack} />
      {lanePack?.path ? <div className="truncate text-[11px] text-muted-fg">{lanePack.path}</div> : null}

      <Dialog.Root open={editDialogOpen} onOpenChange={(open) => setEditDialogOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(980px,calc(100vw-24px))] -translate-x-1/2 rounded-sm border border-border bg-bg p-4 shadow-2xl focus:outline-none">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold">Edit Narrative</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>
            <div className="text-xs text-muted-fg">
              This updates the <span className="font-mono">## Narrative</span> section for this pack and creates a new immutable version.
            </div>
            <textarea
              className="mt-3 h-[320px] w-full rounded border border-border bg-card/50 p-2 text-xs text-fg font-mono"
              value={narrativeDraft}
              onChange={(e) => setNarrativeDraft(e.target.value)}
              placeholder="Write the narrative you want ADE to keep for this lane…"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(false)} disabled={narrativeBusy}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => void saveNarrative()} disabled={narrativeBusy || !lanePack?.packKey}>
                {narrativeBusy ? "Saving…" : "Save Narrative"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={versionsDialogOpen} onOpenChange={(open) => setVersionsDialogOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(980px,calc(100vw-24px))] -translate-x-1/2 rounded-sm border border-border bg-bg p-4 shadow-2xl focus:outline-none">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold">Pack Versions</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>
            {versionsLoading ? (
              <div className="rounded border border-border bg-card/40 p-3 text-xs text-muted-fg">Loading versions…</div>
            ) : (
              <div className="grid min-h-0 grid-cols-[320px_1fr] gap-3">
                <div className="max-h-[65vh] overflow-auto rounded border border-border bg-card/30 p-2">
                  {versions.length === 0 ? (
                    <div className="p-2 text-xs text-muted-fg">No versions recorded yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {versions.map((v) => (
                        <div key={v.id} className="rounded border border-border bg-bg/40 p-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-fg">v{v.versionNumber}</div>
                            <div className="text-[11px] text-muted-fg">{new Date(v.createdAt).toLocaleString()}</div>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-fg font-mono break-all">{v.contentHash.slice(0, 12)}</div>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <label className="flex items-center gap-2 text-[11px] text-muted-fg">
                              <input type="radio" name="fromVersion" checked={fromVersionId === v.id} onChange={() => setFromVersionId(v.id)} />
                              from
                            </label>
                            <label className="flex items-center gap-2 text-[11px] text-muted-fg">
                              <input type="radio" name="toVersion" checked={toVersionId === v.id} onChange={() => setToVersionId(v.id)} />
                              to
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="max-h-[65vh] overflow-auto rounded border border-border bg-card/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-fg">Diff</div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={diffBusy || !fromVersionId || !toVersionId || fromVersionId === toVersionId}
                      onClick={() => void runDiff()}
                    >
                      {diffBusy ? "Diffing…" : "Run Diff"}
                    </Button>
                  </div>
                  {diffText ? (
                    <pre className="mt-2 max-h-[52vh] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg/40 p-2 text-[11px] leading-relaxed text-fg">
                      {diffText}
                    </pre>
                  ) : (
                    <div className="mt-2 text-xs text-muted-fg">Select two versions and run diff.</div>
                  )}
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={eventsDialogOpen} onOpenChange={(open) => setEventsDialogOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(980px,calc(100vw-24px))] -translate-x-1/2 rounded-sm border border-border bg-bg p-4 shadow-2xl focus:outline-none">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold">Pack Events</Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>
            {eventsLoading ? (
              <div className="rounded border border-border bg-card/40 p-3 text-xs text-muted-fg">Loading events…</div>
            ) : events.length === 0 ? (
              <div className="rounded border border-border bg-card/40 p-3 text-xs text-muted-fg">No events recorded yet.</div>
            ) : (
              <div className="max-h-[65vh] overflow-auto rounded border border-border bg-card/30">
                <div className="divide-y divide-border">
                  {events.map((ev) => (
                    <div key={ev.id} className="px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-fg">{ev.eventType}</div>
                        <div className="text-[11px] text-muted-fg">{new Date(ev.createdAt).toLocaleString()}</div>
                      </div>
                      <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-fg">
                        {JSON.stringify(ev.payload ?? {}, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
