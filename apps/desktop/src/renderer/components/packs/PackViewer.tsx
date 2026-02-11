import React, { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { BookOpen, RefreshCw } from "lucide-react";
import type { PackSummary } from "../../../shared/types";
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

export function PackViewer({ laneId }: { laneId: string | null }) {
  const [lanePack, setLanePack] = useState<PackSummary | null>(null);
  const [projectPack, setProjectPack] = useState<PackSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    </div>
  );
}
