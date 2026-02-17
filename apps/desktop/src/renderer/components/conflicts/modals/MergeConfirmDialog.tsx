import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../ui/Button";
import { useConflictsState, useConflictsDispatch } from "../state/ConflictsContext";
import type { LaneSummary } from "../../../../shared/types";

export function MergeConfirmDialog({
  lanes,
  onConfirm,
}: {
  lanes: LaneSummary[];
  onConfirm: (targetLaneId: string, sourceLaneId: string) => void;
}) {
  const { mergeConfirmOpen, pendingMerge } = useConflictsState();
  const dispatch = useConflictsDispatch();

  const target = lanes.find((l) => l.id === pendingMerge?.targetLaneId);
  const source = lanes.find((l) => l.id === pendingMerge?.sourceLaneId);

  return (
    <Dialog.Root
      open={mergeConfirmOpen}
      onOpenChange={(open) => {
        dispatch({ type: "SET_MERGE_CONFIRM_OPEN", open });
        if (!open) dispatch({ type: "SET_PENDING_MERGE", merge: null });
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/3 z-50 w-[min(440px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card/95 p-4 shadow-float backdrop-blur-xl focus:outline-none">
          <Dialog.Title className="text-sm font-semibold text-fg">
            Confirm Merge
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-fg">
            This will merge <strong>{source?.name ?? "source"}</strong> into{" "}
            <strong>{target?.name ?? "target"}</strong>.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <div className="rounded-lg bg-muted/20 p-3 text-xs text-muted-fg">
              <div>
                <strong>Source:</strong> {source?.name} ({source?.branchRef})
              </div>
              <div>
                <strong>Target:</strong> {target?.name} ({target?.branchRef})
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button size="sm" variant="outline">Cancel</Button>
              </Dialog.Close>
              <Button
                size="sm"
                variant="primary"
                disabled={!pendingMerge}
                onClick={() => {
                  if (pendingMerge) {
                    onConfirm(pendingMerge.targetLaneId, pendingMerge.sourceLaneId);
                    dispatch({ type: "SET_MERGE_CONFIRM_OPEN", open: false });
                    dispatch({ type: "SET_PENDING_MERGE", merge: null });
                  }
                }}
              >
                Merge
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
