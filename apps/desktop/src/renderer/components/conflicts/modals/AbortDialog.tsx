import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../../ui/Button";
import { useConflictsState, useConflictsDispatch } from "../state/ConflictsContext";
import { abortGitOperation } from "../state/conflictsActions";

export function AbortDialog({ laneId, kind }: { laneId: string; kind: "merge" | "rebase" }) {
  const { abortOpen, abortConfirm, abortBusy, abortError } = useConflictsState();
  const dispatch = useConflictsDispatch();

  const confirmed = abortConfirm.trim().toLowerCase() === "abort";
  const label = kind === "merge" ? "Merge" : "Rebase";

  return (
    <Dialog.Root
      open={abortOpen}
      onOpenChange={(open) => {
        dispatch({ type: "SET_ABORT_OPEN", open });
        if (!open) dispatch({ type: "SET_ABORT_CONFIRM", text: "" });
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/3 z-50 w-[min(400px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-card/95 p-4 shadow-float backdrop-blur-xl focus:outline-none">
          <Dialog.Title className="text-sm font-semibold text-fg">
            Abort {label}?
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-fg">
            This will discard all conflict resolution progress. Type &quot;abort&quot; to confirm.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <input
              type="text"
              value={abortConfirm}
              onChange={(e) => dispatch({ type: "SET_ABORT_CONFIRM", text: e.target.value })}
              placeholder='Type "abort" to confirm'
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
              autoFocus
            />

            {abortError && (
              <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                {abortError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button size="sm" variant="outline">Cancel</Button>
              </Dialog.Close>
              <Button
                size="sm"
                variant="primary"
                disabled={!confirmed || abortBusy}
                onClick={() => void abortGitOperation(dispatch, laneId, kind)}
                className="bg-red-600 hover:bg-red-700"
              >
                {abortBusy ? "Aborting..." : `Abort ${label}`}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
