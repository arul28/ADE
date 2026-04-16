import React from "react";
import { ArrowClockwise, PencilSimple, Play, Plus, Stop, Trash } from "@phosphor-icons/react";
import type { StackButtonDefinition } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";

type RunStackTabsProps = {
  stacks: StackButtonDefinition[];
  selectedStackId: string | null;
  onSelectStack: (stackId: string | null) => void;
  onCreateStack: (name: string) => void;
  onRenameStack: (stackId: string, name: string) => void;
  onDeleteStack: (stackId: string) => void;
  onStartStack: (stackId: string) => void;
  onStopStack: (stackId: string) => void;
  onRestartStack: (stackId: string) => void;
  onUpdateStackStartOrder: (stackId: string, startOrder: "parallel" | "dependency") => void;
};

export function RunStackTabs({
  stacks,
  selectedStackId,
  onSelectStack,
  onCreateStack,
  onRenameStack,
  onDeleteStack,
  onStartStack,
  onStopStack,
  onRestartStack,
  onUpdateStackStartOrder,
}: RunStackTabsProps) {
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [contextMenu, setContextMenu] = React.useState<{ stackId: string; x: number; y: number } | null>(null);
  const createInputRef = React.useRef<HTMLInputElement>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const contextMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  React.useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  React.useEffect(() => {
    if (!contextMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [contextMenu]);

  const submitCreate = () => {
    const trimmed = newName.trim();
    if (trimmed) onCreateStack(trimmed);
    setNewName("");
    setCreating(false);
  };

  const submitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && renamingId) onRenameStack(renamingId, trimmed);
    setRenamingId(null);
    setRenameValue("");
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
    height: 40,
    padding: "0 14px",
    border: "none",
    borderLeft: active ? `2px solid ${COLORS.accent}` : "2px solid transparent",
    borderBottom: active ? `1px solid ${COLORS.accentBorder}` : "1px solid transparent",
    background: active ? COLORS.accentSubtle : "transparent",
    color: active ? COLORS.textPrimary : COLORS.textSecondary,
    cursor: "pointer",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  });

  const renderOrderBadge = (stack: StackButtonDefinition, active: boolean) => (
    <span
      style={{
        fontSize: 9,
        color: active ? COLORS.accent : COLORS.textDim,
        border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
        padding: "1px 4px",
        lineHeight: 1.2,
      }}
      title={stack.startOrder === "dependency" ? "Starts in dependency order" : "Starts in parallel order"}
    >
      {stack.startOrder === "dependency" ? "DEP" : "PAR"}
    </span>
  );

  return (
    <>
      <div
        role="tablist"
        aria-label="Run stacks"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          minHeight: 48,
          padding: "0 20px",
          overflowX: "auto",
          background: "rgba(255,255,255,0.01)",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={selectedStackId === null}
          onClick={() => onSelectStack(null)}
          style={tabStyle(selectedStackId === null)}
          onMouseEnter={(event) => {
            if (selectedStackId !== null) event.currentTarget.style.background = COLORS.hoverBg;
          }}
          onMouseLeave={(event) => {
            if (selectedStackId !== null) event.currentTarget.style.background = "transparent";
          }}
        >
          <span>All commands</span>
        </button>

        {stacks.map((stack) => {
          const active = selectedStackId === stack.id;
          if (renamingId === stack.id) {
            return (
              <div
                key={stack.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  flexShrink: 0,
                  height: 40,
                  padding: "0 10px 0 14px",
                  borderLeft: `2px solid ${COLORS.accent}`,
                  background: COLORS.accentSubtle,
                }}
              >
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitRename();
                    if (event.key === "Escape") {
                      setRenamingId(null);
                      setRenameValue("");
                    }
                  }}
                  onBlur={submitRename}
                  style={{
                    width: 180,
                    height: 28,
                    padding: "0 10px",
                    background: COLORS.pageBg,
                    border: `1px solid ${COLORS.outlineBorder}`,
                    color: COLORS.textPrimary,
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    outline: "none",
                  }}
                />
              </div>
            );
          }

          return (
            <button
              key={stack.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectStack(stack.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({ stackId: stack.id, x: event.clientX, y: event.clientY });
              }}
              style={tabStyle(active)}
              onMouseEnter={(event) => {
                if (!active) event.currentTarget.style.background = COLORS.hoverBg;
              }}
              onMouseLeave={(event) => {
                if (!active) event.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>{stack.name}</span>
              <span style={{ fontSize: 10, color: active ? COLORS.textSecondary : COLORS.textDim }}>
                {stack.processIds.length}
              </span>
              {renderOrderBadge(stack, active)}
            </button>
          );
        })}

        {creating ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
              paddingLeft: 12,
            }}
          >
            <input
              ref={createInputRef}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitCreate();
                if (event.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
              onBlur={submitCreate}
              placeholder="New stack"
              style={{
                width: 160,
                height: 28,
                padding: "0 10px",
                background: COLORS.pageBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
                fontSize: 11,
                outline: "none",
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            style={{
              ...outlineButton({ height: 28, padding: "0 10px" }),
              marginLeft: 12,
              flexShrink: 0,
            }}
          >
            <Plus size={12} weight="bold" />
            New stack
          </button>
        )}
      </div>

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="ade-liquid-glass-menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 120,
            minWidth: 190,
            padding: "4px 0",
          }}
        >
          {([
            {
              label: "Start stack",
              icon: <Play size={12} weight="fill" />,
              action: () => onStartStack(contextMenu.stackId),
            },
            {
              label: "Stop stack",
              icon: <Stop size={12} weight="fill" />,
              action: () => onStopStack(contextMenu.stackId),
            },
            {
              label: "Restart stack",
              icon: <ArrowClockwise size={12} weight="bold" />,
              action: () => onRestartStack(contextMenu.stackId),
            },
            {
              label:
                stacks.find((entry) => entry.id === contextMenu.stackId)?.startOrder === "dependency"
                  ? "Use parallel order"
                  : "Use dependency order",
              icon: <ArrowClockwise size={12} weight="bold" />,
              action: () => {
                const stack = stacks.find((entry) => entry.id === contextMenu.stackId);
                if (!stack) return;
                onUpdateStackStartOrder(stack.id, stack.startOrder === "dependency" ? "parallel" : "dependency");
              },
            },
            {
              label: "Rename stack",
              icon: <PencilSimple size={12} weight="bold" />,
              action: () => {
                const stack = stacks.find((entry) => entry.id === contextMenu.stackId);
                if (!stack) return;
                setRenamingId(stack.id);
                setRenameValue(stack.name);
              },
            },
            {
              label: "Delete stack",
              icon: <Trash size={12} weight="bold" />,
              action: () => onDeleteStack(contextMenu.stackId),
              danger: true,
            },
          ] as Array<{ label: string; icon: React.ReactNode; action: () => void; danger?: boolean }>).map((item, index) => (
            <React.Fragment key={item.label}>
              {index === 4 ? <div style={{ height: 1, margin: "4px 0", background: COLORS.border }} /> : null}
              <button
                type="button"
                onClick={() => {
                  item.action();
                  setContextMenu(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "7px 12px",
                  background: "transparent",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                  color: item.danger ? COLORS.danger : COLORS.textSecondary,
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  fontWeight: 600,
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = COLORS.hoverBg;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                }}
              >
                {item.icon}
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </>
  );
}
