import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowClockwise, CaretDown, Play, Rocket, Stop, Terminal } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import type { StackButtonDefinition } from "../../../shared/types";

type QuickRunMenuProps = {
  laneId: string | null;
  align?: "start" | "center" | "end";
  compact?: boolean;
  iconOnly?: boolean;
  label?: string;
  triggerStyle?: React.CSSProperties;
};

const menuContentStyle: React.CSSProperties = {
  minWidth: 240,
  maxWidth: 320,
  padding: 6,
  zIndex: 300,
};

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 10px",
  background: "transparent",
  border: "none",
  color: COLORS.textSecondary,
  cursor: "pointer",
  fontFamily: MONO_FONT,
  fontSize: 11,
  fontWeight: 600,
  textAlign: "left",
};

const menuSectionLabelStyle: React.CSSProperties = {
  padding: "6px 10px 4px",
  color: COLORS.textDim,
  fontFamily: MONO_FONT,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
};

function QuickRunItem({
  icon,
  label,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void | Promise<void>;
}) {
  return (
    <DropdownMenu.Item
      onSelect={(event) => {
        event.preventDefault();
        void onSelect();
      }}
      style={menuItemStyle}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = COLORS.hoverBg;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
      }}
    >
      {icon}
      <span style={{ minWidth: 0, flex: 1 }}>{label}</span>
    </DropdownMenu.Item>
  );
}

function isTrustError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("ADE_TRUST_REQUIRED");
}

async function startAllWithTrust(laneId: string): Promise<void> {
  try {
    await window.ade.processes.startAll({ laneId });
  } catch (err) {
    if (isTrustError(err)) {
      await window.ade.projectConfig.confirmTrust();
      await window.ade.processes.startAll({ laneId });
    } else {
      throw err;
    }
  }
}

export function QuickRunMenu({
  laneId,
  align = "start",
  compact = false,
  iconOnly = false,
  label = "Run",
  triggerStyle,
}: QuickRunMenuProps) {
  const navigate = useNavigate();
  const selectLane = useAppStore((s) => s.selectLane);
  const selectRunLane = useAppStore((s) => s.selectRunLane);
  const [open, setOpen] = React.useState(false);
  const [stacks, setStacks] = React.useState<StackButtonDefinition[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open || !laneId) return;
    let cancelled = false;
    setLoading(true);
    window.ade.projectConfig
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        setStacks(snapshot.effective.stackButtons ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setStacks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, open]);

  const syncLaneSelection = React.useCallback(() => {
    if (!laneId) return false;
    selectLane(laneId);
    selectRunLane(laneId);
    return true;
  }, [laneId, selectLane, selectRunLane]);

  const handleOpenRun = React.useCallback(() => {
    if (!syncLaneSelection()) return;
    navigate("/project");
  }, [navigate, syncLaneSelection]);

  const handleOpenShell = React.useCallback(() => {
    if (!laneId) return;
    selectLane(laneId);
    navigate("/work");
  }, [laneId, navigate, selectLane]);

  const triggerBaseStyle = iconOnly
    ? outlineButton({ height: compact ? 24 : 28, padding: compact ? "0 6px" : "0 8px", fontSize: 10 })
    : outlineButton({ height: compact ? 24 : 28, padding: compact ? "0 8px" : "0 10px", fontSize: 10 });

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={!laneId}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            ...triggerBaseStyle,
            gap: 6,
            opacity: laneId ? 1 : 0.45,
            cursor: laneId ? "pointer" : "default",
            ...triggerStyle,
          }}
        >
          <Rocket size={12} weight="bold" />
          {!iconOnly ? <span>{label}</span> : null}
          {!iconOnly ? <CaretDown size={10} weight="bold" /> : null}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={6} align={align} className="ade-liquid-glass-menu" style={menuContentStyle}>
          <div style={menuSectionLabelStyle}>Lane runtime</div>
          <QuickRunItem icon={<Rocket size={12} />} label="Open Run tab" onSelect={handleOpenRun} />
          <QuickRunItem icon={<Terminal size={12} />} label="Open shell in Work" onSelect={handleOpenShell} />
          <QuickRunItem
            icon={<Play size={12} weight="fill" />}
            label="Start all commands"
            onSelect={async () => {
              if (!syncLaneSelection()) return;
              if (!laneId) return;
              await startAllWithTrust(laneId);
            }}
          />
          <QuickRunItem
            icon={<Stop size={12} weight="fill" />}
            label="Stop all commands"
            onSelect={async () => {
              syncLaneSelection();
              if (!laneId) return;
              await window.ade.processes.stopAll({ laneId });
            }}
          />
          <QuickRunItem
            icon={<ArrowClockwise size={12} weight="bold" />}
            label="Restart all commands"
            onSelect={async () => {
              syncLaneSelection();
              if (!laneId) return;
              await window.ade.processes.stopAll({ laneId });
              await startAllWithTrust(laneId);
            }}
          />

          <DropdownMenu.Separator style={{ height: 1, margin: "6px 0", background: COLORS.border }} />
          <div style={menuSectionLabelStyle}>Stacks</div>
          {loading ? (
            <div style={{ padding: "6px 10px", color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10 }}>
              Loading stack actions...
            </div>
          ) : stacks.length === 0 ? (
            <div style={{ padding: "6px 10px", color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10 }}>
              No stack buttons configured.
            </div>
          ) : (
            stacks.map((stack) => (
              <React.Fragment key={stack.id}>
                <div style={{ ...menuSectionLabelStyle, paddingTop: 8 }}>
                  {stack.name} · {stack.startOrder === "dependency" ? "dependency order" : "parallel order"}
                </div>
                <QuickRunItem
                  icon={<Play size={12} weight="fill" />}
                  label={`Start ${stack.name}`}
                  onSelect={async () => {
                    if (!syncLaneSelection()) return;
                    if (!laneId) return;
                    await window.ade.processes.startStack({ laneId, stackId: stack.id });
                  }}
                />
                <QuickRunItem
                  icon={<Stop size={12} weight="fill" />}
                  label={`Stop ${stack.name}`}
                  onSelect={async () => {
                    syncLaneSelection();
                    if (!laneId) return;
                    await window.ade.processes.stopStack({ laneId, stackId: stack.id });
                  }}
                />
                <QuickRunItem
                  icon={<ArrowClockwise size={12} weight="bold" />}
                  label={`Restart ${stack.name}`}
                  onSelect={async () => {
                    syncLaneSelection();
                    if (!laneId) return;
                    await window.ade.processes.restartStack({ laneId, stackId: stack.id });
                  }}
                />
              </React.Fragment>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
