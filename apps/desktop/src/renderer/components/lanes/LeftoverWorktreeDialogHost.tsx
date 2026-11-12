import { useEffect, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import type { LaneDeleteLeftoverWorktree, OpenProjectBinding } from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { revealLabel } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { extractError } from "../../lib/format";
import { deleteEventBinding } from "../app/toast/useLaneWorkSavedToast";
import { useTabCopyPin } from "../../state/repositoryScope";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice";

/**
 * Where the delete ran: the user can switch tabs while a delete runs and
 * before answering, so the folder's actions must not follow the active tab.
 * The event's `origin` (the binding the delete started with) names it; the
 * copy the event came from is the fallback for a delete this window did not
 * start. `pin` names that copy; a project on this computer also passes its
 * `rootPath`.
 */
type LeftoverPrompt = LaneDeleteLeftoverWorktree & {
  laneId: string;
  pin: OpenProjectBinding | null;
  rootPath: string | null;
};

function leftoverArgs(prompt: LeftoverPrompt): { laneId: string; rootPath?: string } {
  return prompt.rootPath ? { laneId: prompt.laneId, rootPath: prompt.rootPath } : { laneId: prompt.laneId };
}

/**
 * After a lane delete leaves an external folder on disk, ask once what to do
 * with it. Close keeps the folder. Delete folder removes that directory only.
 */
export function LeftoverWorktreeDialogHost(): JSX.Element | null {
  const [queue, setQueue] = useState<LeftoverPrompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const current = queue[0] ?? null;

  // Follows the open copy's deletes, as before; its machine is named.
  const tabPin = useTabCopyPin();
  const tabPinKey = tabPin?.key ?? null;
  useEffect(() => {
    const subscribe = window.ade?.lanes?.onDeleteEvent;
    const subscribedPin = tabPin;
    if (!subscribe || !subscribedPin) return;
    const unsubscribe = subscribe((event) => {
      const progress = event.progress;
      const leftover = progress.leftoverWorktree;
      const finished = progress.overallStatus === "completed" || progress.overallStatus === "completed_with_warnings";
      if (!finished || !leftover?.path) return;
      const binding = deleteEventBinding(event, subscribedPin);
      setQueue((existing) => {
        if (existing.some((entry) => entry.laneId === progress.laneId && entry.path === leftover.path)) {
          return existing;
        }
        const pin = binding;
        const rootPath = binding?.kind === "local" ? binding.rootPath : null;
        return [...existing, { ...leftover, laneId: progress.laneId, pin, rootPath }];
      });
    }, subscribedPin);
    return unsubscribe;
    // `tabPinKey` carries the pin's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabPinKey]);

  useEffect(() => {
    setError(null);
    setDeleting(false);
  }, [current?.laneId, current?.path]);

  if (!current) return null;

  const dismiss = () => {
    setQueue((existing) => existing.slice(1));
  };

  const reveal = () => {
    if (!current.pin) return;
    void window.ade.lanes.revealLeftoverWorktree(leftoverArgs(current), current.pin).catch((reason: unknown) => {
      setError(extractError(reason));
    });
  };

  const remove = () => {
    if (!current.pin) return;
    setDeleting(true);
    setError(null);
    void window.ade.lanes.deleteLeftoverWorktree(leftoverArgs(current), current.pin)
      .then(() => dismiss())
      .catch((reason: unknown) => {
        setDeleting(false);
        setError(stripElectronErrorWrapper(extractError(reason)));
      });
  };

  const showReveal = !isWebClientMode();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) dismiss();
      }}
      title="Folder left on disk"
      description={
        current.canDelete
          ? `${current.laneName} was deleted. Git no longer has this folder as a worktree, so it was left in place.`
          : `${current.laneName} was deleted. This path is a symbolic link, so the folder it points at was left in place.`
      }
      tone="warning"
      icon={<FolderOpen size={18} weight="duotone" />}
      testId="leftover-worktree-dialog"
      actions={[
        ...(showReveal
          ? [{ label: revealLabel, variant: "secondary" as const, onClick: reveal, disabled: deleting }]
          : []),
        ...(current.canDelete
          ? [{
              label: "Delete folder",
              variant: "solid" as const,
              onClick: remove,
              busy: deleting,
              autoFocus: true,
            }]
          : []),
        { label: "Close", variant: "secondary" as const, onClick: dismiss, disabled: deleting },
      ]}
    >
      <p className="break-all font-mono text-[12px] text-fg/80">{current.path}</p>
      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 8 }}
          model={{
            id: "leftover-worktree-error",
            tone: "error",
            title: error,
            report: { surface: "leftover_worktree" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}
    </Dialog>
  );
}
