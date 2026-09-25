import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Trash, type Icon } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS } from "../ui/paneMenuTokens";

/**
 * The pane's two-row destructive menu item.
 *
 * Written once because both Apple menus carry the same idiom: a red row that,
 * on choose, is DISABLED in place and a confirmation row appears beneath it.
 * The callers own the `confirming` state and reset it when their menu closes.
 *
 * The idle row stays mounted rather than being replaced by the confirm, and
 * that is the safety property, not a styling choice: a rapid double-click sends
 * its second click to the same screen coordinate, which is the now-disabled
 * idle row, so it cannot land on the confirmation and delete without a
 * deliberate second press. Replacing the row in place put the confirmation
 * exactly where the second click landed.
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
  icon: ItemIcon = Trash,
}: {
  /** True once the first row was chosen: disable it and show the confirmation. */
  confirming: boolean;
  idleLabel: string;
  confirmLabel: string;
  /** e.g. `{ name: "data-apple-tool-card-delete", value: udid }`. */
  idleDataAttribute: { name: string; value: string };
  confirmDataAttribute: { name: string; value: string };
  onBeginConfirm: () => void;
  onConfirm: () => void;
  /**
   * Paint the rows red. True for a delete; false for a release that merely
   * ends a live session, which is disruptive rather than destructive.
   */
  danger?: boolean;
  /** Row glyph. Defaults to `Trash`; a release passes `Eject`. */
  icon?: Icon;
}) {
  const className = cn(MENU_ITEM_CLASS, danger && "text-[var(--color-error)]");
  return (
    <>
      <DropdownMenu.Item
        className={className}
        disabled={confirming}
        {...{ [idleDataAttribute.name]: idleDataAttribute.value }}
        onSelect={(event) => {
          // Keep the menu open: the confirmation appears just below, and the
          // idle row stays put (disabled) so the same gesture cannot reach it.
          event.preventDefault();
          onBeginConfirm();
        }}
      >
        <ItemIcon size={14} />
        {idleLabel}
      </DropdownMenu.Item>
      {confirming ? (
        <DropdownMenu.Item
          className={className}
          {...{ [confirmDataAttribute.name]: confirmDataAttribute.value }}
          onSelect={onConfirm}
        >
          <ItemIcon size={14} />
          {confirmLabel}
        </DropdownMenu.Item>
      ) : null}
    </>
  );
}
