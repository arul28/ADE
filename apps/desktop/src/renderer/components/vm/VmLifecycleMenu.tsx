import { ArrowCounterClockwise, DotsThree, StopCircle, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

type LifecycleAction = {
  key: "restart" | "wipe" | "force-stop";
  label: string;
  icon: typeof DotsThree;
  danger?: boolean;
  visible: boolean;
  onSelect: () => void;
};

export function VmLifecycleMenu({
  canRestart,
  canForceStop,
  canWipe,
  onRestart,
  onWipe,
  onForceStop,
}: {
  canRestart: boolean;
  canForceStop: boolean;
  canWipe: boolean;
  onRestart: () => void;
  onWipe: () => void;
  onForceStop: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handle = useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const actions: LifecycleAction[] = [
    {
      key: "restart",
      label: "Restart VM",
      icon: ArrowCounterClockwise,
      visible: canRestart,
      onSelect: () => handle(onRestart),
    },
    {
      key: "wipe",
      label: "Wipe & reinstall",
      icon: Trash,
      danger: true,
      visible: canWipe,
      onSelect: () => handle(onWipe),
    },
    {
      key: "force-stop",
      label: "Force stop",
      icon: StopCircle,
      visible: canForceStop,
      onSelect: () => handle(onForceStop),
    },
  ];

  const visibleActions = actions.filter((action) => action.visible);
  if (!visibleActions.length) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="VM lifecycle menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ade-shell-control inline-flex h-8 w-8 items-center justify-center rounded-md"
        data-variant="ghost"
      >
        <DotsThree size={16} weight="bold" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 flex w-[200px] flex-col rounded-md py-1 shadow-xl"
          style={{
            background: "#13101A",
            border: "1px solid #2A2535",
          }}
        >
          {visibleActions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.key}
                role="menuitem"
                type="button"
                onClick={action.onSelect}
                className="flex items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/5"
                style={{ color: action.danger ? "var(--color-error, #ef4444)" : "#E4E4E7" }}
              >
                <Icon size={13} weight={action.danger ? "fill" : "regular"} />
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
