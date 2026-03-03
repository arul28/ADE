import React from "react";
import type { LaneSummary } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import type { IntegrationDialogState } from "../graphTypes";

export function IntegrationDialog({
  integrationDialog,
  setIntegrationDialog,
  laneById,
  primaryLaneId,
  refreshLanes,
  setSelectedLaneIds,
  navigate
}: {
  integrationDialog: IntegrationDialogState;
  setIntegrationDialog: React.Dispatch<React.SetStateAction<IntegrationDialogState | null>>;
  laneById: Map<string, LaneSummary>;
  primaryLaneId: string | null;
  refreshLanes: () => Promise<void>;
  setSelectedLaneIds: React.Dispatch<React.SetStateAction<string[]>>;
  navigate: (path: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
      <div className="w-[min(780px,100%)] rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-float">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-fg">Create Integration Lane</div>
          <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setIntegrationDialog(null)}>
            ×
          </button>
        </div>

        {integrationDialog.error ? (
          <div className="mb-2 rounded bg-red-900/30 p-2 text-xs text-red-200">
            {integrationDialog.error}
          </div>
        ) : null}

        <div className="mb-2 text-xs text-muted-fg">
          This will create a new lane branched from Primary and merge the selected lanes into it.
        </div>

        <input
          className="mb-2 h-9 w-full rounded border border-border/15 bg-surface-recessed px-3 text-sm"
          value={integrationDialog.name}
          onChange={(e) => setIntegrationDialog((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
          placeholder="Integration lane name"
          disabled={integrationDialog.busy}
        />

        <div className="mb-3 max-h-[160px] overflow-auto rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">
          {integrationDialog.laneIds.map((laneId) => (
            <div key={laneId} className="truncate">
              {laneById.get(laneId)?.name ?? laneId}
            </div>
          ))}
        </div>

        {integrationDialog.step ? (
          <div className="mb-3 rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">{integrationDialog.step}</div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={integrationDialog.busy} onClick={() => setIntegrationDialog(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={integrationDialog.busy || !integrationDialog.name.trim() || !primaryLaneId}
            onClick={() => {
              const draft = integrationDialog;
              if (!draft) return;
              const primaryId = primaryLaneId;
              if (!primaryId) {
                setIntegrationDialog((prev) => (prev ? { ...prev, error: "Primary lane not found." } : prev));
                return;
              }
              const ordered = [...draft.laneIds].filter((id) => id !== primaryId);
              setIntegrationDialog((prev) => (prev ? { ...prev, busy: true, error: null, step: "Creating integration lane…" } : prev));
              window.ade.lanes
                .createChild({ parentLaneId: primaryId, name: draft.name.trim() })
                .then(async (newLane) => {
                  for (const sourceLaneId of ordered) {
                    const source = laneById.get(sourceLaneId);
                    if (!source) continue;
                    setIntegrationDialog((prev) =>
                      prev ? { ...prev, step: `Merging ${source.name}…` } : prev
                    );
                    await window.ade.git.sync({
                      laneId: newLane.id,
                      mode: "merge",
                      baseRef: source.branchRef
                    });
                  }
                  setIntegrationDialog((prev) => (prev ? { ...prev, step: "Done." } : prev));
                  window.setTimeout(() => setIntegrationDialog(null), 300);
                  await refreshLanes();
                  setSelectedLaneIds([newLane.id]);
                  navigate(`/lanes?laneId=${encodeURIComponent(newLane.id)}&focus=single`);
                })
                .catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  setIntegrationDialog((prev) => (prev ? { ...prev, busy: false, error: message, step: null } : prev));
                });
            }}
          >
            {integrationDialog.busy ? "Working…" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
