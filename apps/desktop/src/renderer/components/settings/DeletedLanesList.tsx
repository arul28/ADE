import React from "react";
import { ArrowCounterClockwise, CircleNotch, GitBranch, X } from "@phosphor-icons/react";
import type { DeletedLaneSnapshot, OpenProjectBinding } from "../../../shared/types";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { restoredLaneToast } from "../app/toast/restoredLaneToast";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";

const TOAST_ID = "settings-deleted-lanes";
const DAY_MS = 24 * 60 * 60 * 1000;

function daysLeft(lane: DeletedLaneSnapshot): string {
  const days = Math.max(0, Math.ceil((Date.parse(lane.expiresAt) - Date.now()) / DAY_MS));
  return days <= 1 ? "kept 1 more day" : `kept ${days} more days`;
}

/**
 * Deleted lanes whose unsaved work ADE kept: uncommitted files and commits no
 * other branch or remote held. Restore brings one back as a new lane with
 * those files; its chats stay in the list below, to reopen into it.
 *
 * Reads and acts on the machine the page shows (`pin`). A machine on an
 * older ADE has no saves to list, so the block stays away there.
 */
export function DeletedLanesList({ pin }: { pin: OpenProjectBinding | null }) {
  const pinRef = React.useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? "";
  const [lanes, setLanes] = React.useState<DeletedLaneSnapshot[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [running, setRunning] = React.useState<{ id: string; kind: "restore" | "remove" } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLanes(null);
    setLoadError(null);
    setRunning(null);
    const list = window.ade.lanes?.listDeleted;
    if (!list) return;
    void list(pinRef.current)
      .then((result) => {
        if (!cancelled) setLanes(Array.isArray(result) ? result : []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLanes([]);
        // A machine on an older ADE simply has none to list.
        if (isUnsupportedAdeActionError(error)) return;
        console.warn("deleted_lanes.load_failed", error);
        setLoadError(ipcErrorMessage(error) || "Something went wrong.");
      });
    return () => {
      cancelled = true;
    };
  }, [pinKey, attempt]);

  const restore = async (lane: DeletedLaneSnapshot) => {
    if (running) return;
    setRunning({ id: lane.id, kind: "restore" });
    try {
      const result = await window.ade.lanes.restoreDeleted({ id: lane.id }, pinRef.current);
      if (result.restoredUncommitted) {
        setLanes((prev) => prev?.filter((entry) => entry.id !== lane.id) ?? prev);
      }
      showToast({
        id: TOAST_ID,
        ...restoredLaneToast(lane, result, lane.kind === "freed" ? undefined : "Its chats are below; Reopen puts them in the lane."),
      });
    } catch (error) {
      showToast({
        id: TOAST_ID,
        tone: "error",
        title: `Couldn't restore ${lane.laneName}`,
        message: ipcErrorMessage(error) || "Something went wrong.",
        replayMask: { title: true },
      });
    } finally {
      setRunning(null);
    }
  };

  const remove = async (lane: DeletedLaneSnapshot) => {
    if (running) return;
    const ok = await confirmDialog({
      title: "Drop this lane's saved work?",
      message: lane.kind === "freed"
        ? `“${lane.laneName}” stays archived, but ADE will no longer be able to put back its uncommitted files.`
        : lane.uncommitted
          ? `ADE will no longer be able to bring back “${lane.laneName}” or its uncommitted files.`
          : `ADE will no longer be able to bring back “${lane.laneName}”. Commits that only it held are lost.`,
      confirmLabel: "Drop",
      destructive: true,
    });
    if (!ok) return;
    setRunning({ id: lane.id, kind: "remove" });
    try {
      await window.ade.lanes.removeDeleted({ id: lane.id }, pinRef.current);
      setLanes((prev) => prev?.filter((entry) => entry.id !== lane.id) ?? prev);
    } catch (error) {
      showToast({ id: TOAST_ID, tone: "error", title: "Couldn't drop that lane", message: ipcErrorMessage(error) || "Something went wrong." });
    } finally {
      setRunning(null);
    }
  };

  if (loadError) {
    return (
      <div className="ade-ar-block" data-deleted-lanes>
        <Banner
          layout="inline"
          model={{
            id: "deleted-lanes-load-error",
            tone: "error",
            title: "ADE couldn't read the deleted lanes",
            detail: loadError,
            actions: [{ label: "Try again", onClick: () => setAttempt((value) => value + 1) }],
          }}
        />
      </div>
    );
  }

  if (!lanes || lanes.length === 0) return null;

  return (
    <div className="ade-ar-block" data-deleted-lanes>
      <div className="ade-ar-group">
        <span className="kit-eyebrow">Lanes</span>
        <span className="ade-ar-group-count kit-num">{lanes.length}</span>
      </div>
      <div role="list" aria-label="Deleted lanes" className="ade-modern-rows ade-ar-list">
        {lanes.map((lane) => {
          const restoring = running?.id === lane.id && running.kind === "restore";
          return (
            <div key={lane.id} role="listitem" className="ade-ar-row ade-rd-row">
              <div className="ade-rd-open ade-rd-info">
                <span className="ade-ar-mark">
                  <GitBranch size={15} />
                </span>
                <span className="ade-rd-text">
                  <span className="ade-ar-title">{lane.laneName}</span>
                  <span className="ade-ar-meta">
                    {lane.branchName ? <span className="kit-num ade-rd-nowrap">{lane.branchName}</span> : null}
                    {lane.branchName ? <span aria-hidden className="ade-rd-sep">·</span> : null}
                    <span className="ade-rd-nowrap">{lane.uncommitted ? "Uncommitted files saved" : "Unpushed commits saved"}</span>
                    <span aria-hidden className="ade-rd-sep">·</span>
                    <span className="kit-num ade-rd-nowrap">
                      {lane.kind === "freed" ? "Space freed" : "Deleted"} {relativeWhen(lane.deletedAt)}, {daysLeft(lane)}
                    </span>
                  </span>
                </span>
              </div>
              <div className="ade-rd-actions">
                <button
                  type="button"
                  aria-label="Drop saved work"
                  title="Drop saved work"
                  disabled={running != null}
                  onClick={() => void remove(lane)}
                  className="ade-ar-icon-btn ade-rd-hover"
                >
                  <X size={14} />
                </button>
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  disabled={running != null}
                  onClick={() => void restore(lane)}
                >
                  {restoring ? <CircleNotch size={12} className="animate-spin" /> : <ArrowCounterClockwise size={12} />}
                  {lane.kind === "freed"
                    ? restoring ? "Putting back…" : "Put back"
                    : restoring ? "Restoring…" : "Restore"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
