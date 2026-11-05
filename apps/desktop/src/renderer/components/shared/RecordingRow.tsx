import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DotsThree } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../ui/paneMenuTokens";
import { PaneTooltip } from "../ui/PaneTooltip";
import { DRAWER_BUTTON, DRAWER_ICON_BUTTON } from "../ui/drawerPrimitives";
import { revealLabel } from "../../lib/platform";

/** The label, else "Recording HH:MM:SS" from the start time, else the id. */
export function recordingDisplayName(recording: { id: string; label?: string | null; startedAt: string }): string {
  if (recording.label?.trim()) return recording.label.trim();
  const at = new Date(recording.startedAt);
  if (Number.isNaN(at.getTime())) return recording.id;
  return `Recording ${at.toLocaleTimeString([], { hour12: false })}`;
}

/**
 * One finished recording in a device drawer's Capture card: the name and a
 * detail line, **Open in proof** (disabled, never hidden, while it has no
 * proof row), and a `⋯` menu with Reveal and Delete.
 */
export function RecordingRow({
  name,
  detail,
  artifactId,
  enabled,
  onOpenProof,
  onReveal,
  revealUnavailable = null,
  onDelete,
  deleteDisabled = false,
}: {
  name: string;
  detail: ReactNode;
  artifactId: string | null;
  /** False while the drawer is hidden. */
  enabled: boolean;
  onOpenProof: (artifactId: string) => void;
  onReveal: () => void;
  /** Set when the file cannot be revealed here; the menu item shows this text, disabled. */
  revealUnavailable?: string | null;
  onDelete: () => void;
  deleteDisabled?: boolean;
}) {
  const canOpenProof = Boolean(enabled && artifactId);
  return (
    <li className="flex min-h-7 min-w-0 flex-nowrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-fg/85" title={name}>{name}</div>
        <div className="truncate text-[11px] text-muted-fg">{detail}</div>
      </div>
      <PaneTooltip label={artifactId ? `Open ${name} in proof` : "This recording is not in proof yet"} side="left">
        <button
          type="button"
          className={cn(DRAWER_BUTTON, "shrink-0")}
          disabled={!canOpenProof}
          onClick={() => { if (artifactId) onOpenProof(artifactId); }}
        >
          Open in proof
        </button>
      </PaneTooltip>
      <DropdownMenu.Root>
        <PaneTooltip label={`More for ${name}`} side="left">
          <DropdownMenu.Trigger asChild>
            <button type="button" className={DRAWER_ICON_BUTTON} aria-label={`More for ${name}`} disabled={!enabled}>
              <DotsThree size={14} weight="bold" />
            </button>
          </DropdownMenu.Trigger>
        </PaneTooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
            <DropdownMenu.Item
              className={cn(MENU_ITEM_CLASS, "text-[12px]")}
              disabled={revealUnavailable != null}
              onSelect={onReveal}
            >
              {revealUnavailable ?? revealLabel}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={cn(MENU_ITEM_CLASS, "text-[12px] text-[var(--color-error)]")}
              disabled={deleteDisabled}
              onSelect={onDelete}
            >
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}
