import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { Z_LAYERS } from "../ui/zLayers";

export type MachineAction = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Destructive: drawn in red, after a rule. */
  danger?: boolean;
  /** Keeps the item's accessible name stable where the label is short ("Remove Studio"). */
  ariaLabel?: string;
};

/**
 * A machine row's secondary actions behind one ⋯ button, so the row shows its
 * name, its state and at most one primary button. Destructive items sit last,
 * after a rule, never next to Rename.
 */
export function MachineActionsMenu({ label, actions }: { label: string; actions: MachineAction[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);
  // Escape closes the menu, not the popover around it, and hands focus back.
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    anchorRef.current?.focus();
  };
  if (actions.length === 0) return null;
  const safe = actions.filter((action) => !action.danger);
  const danger = actions.filter((action) => action.danger);
  const item = (action: MachineAction) => (
    <button
      key={action.key}
      type="button"
      role="menuitem"
      className="ade-cx-menu-item"
      data-tone={action.danger ? "danger" : undefined}
      aria-label={action.ariaLabel}
      disabled={action.disabled}
      onClick={() => {
        setOpen(false);
        action.onSelect();
        // The chosen item unmounts with the menu; unless the action moved
        // focus somewhere (a rename field, a dialog), return it to the trigger.
        requestAnimationFrame(() => {
          if (document.activeElement === document.body || document.activeElement == null) {
            anchorRef.current?.focus();
          }
        });
      }}
    >
      <span className="ade-cx-menu-icon">{action.icon}</span>
      {action.label}
    </button>
  );
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ade-cx-kebab"
        aria-label={label}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={closeOnEscape}
      >
        <DotsThree size={18} weight="bold" />
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        role="menu"
        aria-label={label}
        className="ade-cx-menu"
        zIndex={Z_LAYERS.contextMenu}
        onKeyDown={closeOnEscape}
      >
        <div ref={menuRef} style={{ display: "contents" }}>
        {safe.map(item)}
        {safe.length > 0 && danger.length > 0 ? <div className="ade-cx-menu-rule" /> : null}
        {danger.map(item)}
        </div>
      </AnchoredMenu>
    </>
  );
}
