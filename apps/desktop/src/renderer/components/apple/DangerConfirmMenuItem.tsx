import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Trash } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS } from "../ui/paneMenuTokens";

/**
 * The pane's two-row destructive menu item.
 *
 * Written once because both Apple menus carry the same idiom: a red row that,
 * on select, PREVENTS the menu from closing and turns into the confirmation in
 * place, so the device being acted on never changes between the two clicks.
 * `AppleDevicePicker`'s per-device menu and `AppleToolCardMenu` differ only in
 * their labels and their `data-*` hooks, so those are the props. The callers
 * own the `confirming` state and reset it when their menu closes.
 */
export function DangerConfirmMenuItem({
  confirming,
  idleLabel,
  confirmLabel,
  idleDataAttribute,
  confirmDataAttribute,
  onBeginConfirm,
  onConfirm,
  danger = true,
}: {
  /** True once the first row was chosen: render the confirmation row in place. */
  confirming: boolean;
  idleLabel: string;
  confirmLabel: string;
  /** e.g. `{ name: "data-apple-tool-card-delete", value: udid }`. */
  idleDataAttribute: { name: string; value: string };
  confirmDataAttribute: { name: string; value: string };
  onBeginConfirm: () => void;
  onConfirm: () => void;
  /**
   * Paint the row red. True for a delete; false for a release that merely ends
   * a live session, which is disruptive rather than destructive.
   */
  danger?: boolean;
}) {
  const className = cn(MENU_ITEM_CLASS, danger && "text-[var(--color-error)]");
  if (confirming) {
    return (
      <DropdownMenu.Item
        className={className}
        {...{ [confirmDataAttribute.name]: confirmDataAttribute.value }}
        onSelect={onConfirm}
      >
        <Trash size={14} />
        {confirmLabel}
      </DropdownMenu.Item>
    );
  }
  return (
    <DropdownMenu.Item
      className={className}
      {...{ [idleDataAttribute.name]: idleDataAttribute.value }}
      onSelect={(event) => {
        // Keep the menu open: the confirmation is the same row, one step
        // further on.
        event.preventDefault();
        onBeginConfirm();
      }}
    >
      <Trash size={14} />
      {idleLabel}
    </DropdownMenu.Item>
  );
}
