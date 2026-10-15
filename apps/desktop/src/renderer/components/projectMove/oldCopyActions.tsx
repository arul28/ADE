import React, { useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { ProjectMoveRecord } from "../../../shared/types/projectMove";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";
import { cn } from "../ui/cn";
import { confirmDialog } from "../ui/dialog";
import { showToast } from "../app/toast/toastStore";
import { announceProjectMoveChanged, displayPath, formatBytes, formatReminder, REMINDER_CHOICES } from "./projectMoveModel";

export type OldCopyChoice = "delete" | "keep" | { remindInMs: number };

/**
 * What happens to the copy a move kept: the one path every surface (the move
 * dialog, the banner, Settings) goes through, so a delete is always confirmed
 * and every choice reports the same way. Returns the updated record, or null
 * when the person cancelled or it failed.
 */
export async function chooseOldCopy(record: ProjectMoveRecord, choice: OldCopyChoice): Promise<ProjectMoveRecord | null> {
  const api = window.ade.projectMove;
  if (!api) return null;
  if (choice === "delete") {
    const confirmed = await confirmDialog({
      title: `Delete the old copy of ${record.projectName}?`,
      message: (
        <>
          <code>{displayPath(record.originalParkedAt ?? "")}</code> · {formatBytes(record.originalBytes)}
        </>
      ),
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return null;
  }
  try {
    const next = await api.cleanup(
      choice === "delete" ? { moveId: record.moveId, choice: "delete" }
        : choice === "keep" ? { moveId: record.moveId, choice: "keep" }
          : { moveId: record.moveId, choice: "remind", remindInMs: choice.remindInMs },
    );
    announceProjectMoveChanged();
    showToast({
      tone: "success",
      title: choice === "delete" ? `Deleted · ${formatBytes(record.originalBytes)} freed`
        : choice === "keep" ? "Old copy kept"
          : `ADE will ask ${formatReminder(next.cleanup.remindAt)}`,
    });
    return next;
  } catch (cause) {
    showToast({ tone: "error", title: "That didn't work", message: cause instanceof Error ? cause.message : String(cause) });
    return null;
  }
}

/** Delete… · Remind me ▾ · Keep, for the kept copy of a moved project. */
export function OldCopyControls({
  record,
  onChange,
}: {
  record: ProjectMoveRecord;
  onChange?: (next: ProjectMoveRecord) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const remindRef = useRef<HTMLButtonElement | null>(null);

  const choose = async (choice: OldCopyChoice) => {
    setMenuOpen(false);
    setBusy(true);
    try {
      const next = await chooseOldCopy(record, choice);
      if (next) onChange?.(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ade-pm-controls">
      <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={busy} onClick={() => void choose("keep")}>Keep</button>
      <button
        ref={remindRef}
        type="button"
        className="kit-btn"
        data-size="sm"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        Remind me <CaretDown size={11} />
      </button>
      <AnchoredMenu
        open={menuOpen}
        anchorRef={remindRef}
        onClose={() => setMenuOpen(false)}
        placement="bottom-end"
        zIndex={Z_LAYERS.dialogPopover}
        className={cn(MENU_SURFACE_CLASS, "w-[160px]")}
        role="menu"
      >
        {REMINDER_CHOICES.map((choice) => (
          <button
            key={choice.label}
            type="button"
            role="menuitem"
            className={cn(MENU_ITEM_CLASS, "w-full hover:bg-fg/[0.07]")}
            onClick={() => void choose({ remindInMs: choice.ms })}
          >
            {choice.label}
          </button>
        ))}
      </AnchoredMenu>
      <button type="button" className="kit-btn" data-size="sm" data-tone="crit" disabled={busy} onClick={() => void choose("delete")}>Delete…</button>
    </div>
  );
}
