import { useRef, useState, type ReactNode } from "react";
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
      >
        {safe.map(item)}
        {safe.length > 0 && danger.length > 0 ? <div className="ade-cx-menu-rule" /> : null}
        {danger.map(item)}
      </AnchoredMenu>
    </>
  );
}
