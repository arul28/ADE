import React from "react";
import { Plus, Trash, PencilSimple } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import type { StackButtonDefinition } from "../../../shared/types";

type RunSidebarProps = {
  stacks: StackButtonDefinition[];
  selectedStackId: string | null; // null means "ALL"
  onSelectStack: (stackId: string | null) => void;
  onCreateStack: (name: string) => void;
  onRenameStack: (stackId: string, name: string) => void;
  onDeleteStack: (stackId: string) => void;
};

export function RunSidebar({
  stacks,
  selectedStackId,
  onSelectStack,
  onCreateStack,
  onRenameStack,
  onDeleteStack,
}: RunSidebarProps) {
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [contextMenu, setContextMenu] = React.useState<{ stackId: string; x: number; y: number } | null>(null);
  const createInputRef = React.useRef<HTMLInputElement>(null);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const contextMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (creating && createInputRef.current) createInputRef.current.focus();
  }, [creating]);

  React.useEffect(() => {
    if (renamingId && renameInputRef.current) renameInputRef.current.focus();
  }, [renamingId]);

  // Close context menu on outside click
  React.useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  const handleCreateSubmit = () => {
    const trimmed = newName.trim();
    if (trimmed) {
      onCreateStack(trimmed);
    }
    setNewName("");
    setCreating(false);
  };

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && renamingId) {
      onRenameStack(renamingId, trimmed);
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const itemStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: 600,
    color: active ? COLORS.accent : COLORS.textSecondary,
    background: active ? COLORS.accentSubtle : "transparent",
    cursor: "pointer",
    border: "none",
    borderLeft: active ? `2px solid ${COLORS.accent}` : "2px solid transparent",
    width: "100%",
    textAlign: "left",
    transition: "background 0.1s, color 0.1s",
  });

  return (
    <div
      style={{
        width: 180,
        minWidth: 180,
        background: COLORS.cardBg,
        borderRight: `1px solid ${COLORS.border}`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{ padding: "14px 12px 8px", ...LABEL_STYLE }}>Stacks</div>

      {/* Stack list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* ALL option */}
        <button
          type="button"
          onClick={() => onSelectStack(null)}
          style={itemStyle(selectedStackId === null)}
          onMouseEnter={(e) => {
            if (selectedStackId !== null) (e.currentTarget as HTMLButtonElement).style.background = COLORS.hoverBg;
          }}
          onMouseLeave={(e) => {
            if (selectedStackId !== null) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          ALL
        </button>

        {stacks.map((stack) => (
          <div key={stack.id}>
            {renamingId === stack.id ? (
              <div style={{ padding: "4px 12px" }}>
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSubmit();
                    if (e.key === "Escape") {
                      setRenamingId(null);
                      setRenameValue("");
                    }
                  }}
                  onBlur={handleRenameSubmit}
                  style={{
                    width: "100%",
                    background: COLORS.recessedBg,
                    border: `1px solid ${COLORS.outlineBorder}`,
                    borderRadius: 0,
                    padding: "4px 8px",
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    color: COLORS.textPrimary,
                    outline: "none",
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onSelectStack(stack.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ stackId: stack.id, x: e.clientX, y: e.clientY });
                }}
                style={itemStyle(selectedStackId === stack.id)}
                onMouseEnter={(e) => {
                  if (selectedStackId !== stack.id) (e.currentTarget as HTMLButtonElement).style.background = COLORS.hoverBg;
                }}
                onMouseLeave={(e) => {
                  if (selectedStackId !== stack.id) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                {stack.name}
              </button>
            )}
          </div>
        ))}

        {/* Inline create */}
        {creating && (
          <div style={{ padding: "4px 12px" }}>
            <input
              ref={createInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateSubmit();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
              onBlur={handleCreateSubmit}
              placeholder="Stack name..."
              style={{
                width: "100%",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                borderRadius: 0,
                padding: "4px 8px",
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: COLORS.textPrimary,
                outline: "none",
              }}
            />
          </div>
        )}
      </div>

      {/* Add stack button */}
      <button
        type="button"
        onClick={() => setCreating(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 12px",
          fontFamily: MONO_FONT,
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px",
          color: COLORS.textMuted,
          background: "transparent",
          border: "none",
          borderTop: `1px solid ${COLORS.border}`,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = COLORS.accent;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = COLORS.textMuted;
        }}
      >
        <Plus size={12} weight="bold" />
        New Stack
      </button>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            position: "fixed",
            top: Math.min(contextMenu.y, window.innerHeight - 100),
            left: Math.min(contextMenu.x, window.innerWidth - 160),
            zIndex: 100,
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 0,
            minWidth: 140,
            padding: "4px 0",
          }}
        >
          <button
            type="button"
            onClick={() => {
              const stack = stacks.find((s) => s.id === contextMenu.stackId);
              if (stack) {
                setRenamingId(stack.id);
                setRenameValue(stack.name);
              }
              setContextMenu(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              padding: "6px 12px",
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 600,
              color: COLORS.textSecondary,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = COLORS.hoverBg;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <PencilSimple size={12} />
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              onDeleteStack(contextMenu.stackId);
              setContextMenu(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              padding: "6px 12px",
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 600,
              color: COLORS.danger,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = COLORS.hoverBg;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <Trash size={12} />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
