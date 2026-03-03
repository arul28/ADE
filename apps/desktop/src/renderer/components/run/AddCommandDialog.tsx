import React from "react";
import { X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, primaryButton, outlineButton } from "../lanes/laneDesignTokens";
import type { StackButtonDefinition } from "../../../shared/types";

export type AddCommandInitialValues = {
  name: string;
  command: string;
  stackId: string | null;
  cwd: string;
};

export type AddCommandDialogProps = {
  stacks: StackButtonDefinition[];
  open: boolean;
  onClose: () => void;
  onSubmit: (cmd: {
    name: string;
    command: string;
    stackId: string | null;
    newStackName: string | null;
    cwd: string;
  }) => void;
  /** When provided, the dialog operates in "edit" mode with pre-filled values. */
  initialValues?: AddCommandInitialValues | null;
  /** Dialog title override. Defaults to "Add Command". */
  title?: string;
  /** Submit button label override. Defaults to "Add". */
  submitLabel?: string;
};

export function AddCommandDialog({
  stacks,
  open,
  onClose,
  onSubmit,
  initialValues,
  title,
  submitLabel,
}: AddCommandDialogProps) {
  const [name, setName] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [stackId, setStackId] = React.useState<string>("__none__");
  const [newStackName, setNewStackName] = React.useState("");
  const [cwd, setCwd] = React.useState(".");
  const nameRef = React.useRef<HTMLInputElement>(null);

  const dialogTitle = title ?? "Add Command";
  const dialogSubmitLabel = submitLabel ?? "Add";

  React.useEffect(() => {
    if (open) {
      if (initialValues) {
        setName(initialValues.name);
        setCommand(initialValues.command);
        setStackId(initialValues.stackId ?? "__none__");
        setCwd(initialValues.cwd || ".");
      } else {
        setName("");
        setCommand("");
        setStackId("__none__");
        setCwd(".");
      }
      setNewStackName("");
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open, initialValues]);

  if (!open) return null;

  const canSubmit = name.trim() && command.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      command: command.trim(),
      stackId: stackId === "__none__" ? null : stackId === "__new__" ? null : stackId,
      newStackName: stackId === "__new__" ? newStackName.trim() || null : null,
      cwd: cwd.trim() || ".",
    });
    onClose();
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 32,
    padding: "0 10px",
    background: COLORS.recessedBg,
    border: `1px solid ${COLORS.outlineBorder}`,
    borderRadius: 0,
    fontFamily: MONO_FONT,
    fontSize: 12,
    color: COLORS.textPrimary,
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    ...LABEL_STYLE,
    marginBottom: 6,
    display: "block",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 0,
          width: 420,
          maxWidth: "90vw",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 12,
              fontWeight: 700,
              color: COLORS.textPrimary,
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
          >
            {dialogTitle}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: COLORS.textMuted,
              cursor: "pointer",
              padding: 2,
              display: "flex",
            }}
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>Name</label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Dev Server"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx sst dev"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Stack</label>
            <select
              value={stackId}
              onChange={(e) => setStackId(e.target.value)}
              style={{
                ...inputStyle,
                appearance: "none",
                cursor: "pointer",
              }}
            >
              <option value="__none__">No stack</option>
              {stacks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="__new__">+ New stack...</option>
            </select>
          </div>

          {stackId === "__new__" && (
            <div>
              <label style={labelStyle}>New Stack Name</label>
              <input
                value={newStackName}
                onChange={(e) => setNewStackName(e.target.value)}
                placeholder="e.g. Backend"
                style={inputStyle}
              />
            </div>
          )}

          <div>
            <label style={labelStyle}>Working Directory</label>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="."
              style={inputStyle}
            />
          </div>

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={outlineButton()}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              style={primaryButton({ opacity: canSubmit ? 1 : 0.4, cursor: canSubmit ? "pointer" : "default" })}
            >
              {dialogSubmitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
