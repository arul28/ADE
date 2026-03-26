import React from "react";
import { X, CaretRight, CaretDown } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, primaryButton, outlineButton } from "../lanes/laneDesignTokens";
import type { StackButtonDefinition } from "../../../shared/types";
import { parseCommandLine } from "../../lib/shell";

export type AddCommandInitialValues = {
  name: string;
  command: string;
  stackId: string | null;
  cwd: string;
  env: string;
};

type AddCommandDialogProps = {
  stacks: StackButtonDefinition[];
  open: boolean;
  onClose: () => void;
  laneRootPath?: string | null;
  onSubmit: (cmd: {
    name: string;
    command: string;
    stackId: string | null;
    newStackName: string | null;
    cwd: string;
    env: string;
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
  laneRootPath,
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
  const [envText, setEnvText] = React.useState("");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);

  const dialogTitle = title ?? "Add Command";
  const dialogSubmitLabel = submitLabel ?? "Add";
  const normalizedLaneRoot = React.useMemo(() => normalizePath(laneRootPath), [laneRootPath]);
  const commandError = React.useMemo(() => {
    const trimmed = command.trim();
    if (!trimmed) return null;
    try {
      parseCommandLine(trimmed);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [command]);

  React.useEffect(() => {
    if (open) {
      if (initialValues) {
        setName(initialValues.name);
        setCommand(initialValues.command);
        setStackId(initialValues.stackId ?? "__none__");
        setCwd(initialValues.cwd || ".");
        setEnvText(initialValues.env || "");
        // Auto-expand advanced section when editing a command with non-default values
        const hasStack = initialValues.stackId != null;
        const hasCwd = Boolean(initialValues.cwd) && initialValues.cwd !== ".";
        const hasEnv = Boolean(initialValues.env?.trim());
        setShowAdvanced(hasStack || hasCwd || hasEnv);
      } else {
        setName("");
        setCommand("");
        setStackId("__none__");
        setCwd(".");
        setEnvText("");
        setShowAdvanced(false);
      }
      setNewStackName("");
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open, initialValues]);

  const handleBrowseCwd = React.useCallback(async () => {
    const selected = await window.ade.project.chooseDirectory({
      title: "Choose working directory",
      defaultPath: cwd.trim() ? resolveBrowseDefault(cwd, normalizedLaneRoot) : normalizedLaneRoot ?? undefined,
    });
    if (!selected) return;
    setCwd(normalizeSelectedCwd(selected, normalizedLaneRoot));
  }, [cwd, normalizedLaneRoot]);

  if (!open) return null;

  const canSubmit = Boolean(name.trim() && command.trim() && !commandError);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      command: command.trim(),
      stackId: showAdvanced ? (stackId === "__none__" ? null : stackId === "__new__" ? null : stackId) : null,
      newStackName: showAdvanced && stackId === "__new__" ? newStackName.trim() || null : null,
      cwd: showAdvanced ? (cwd.trim() || ".") : ".",
      env: showAdvanced ? envText.trim() : "",
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
            <div
              style={{
                marginTop: 6,
                fontFamily: MONO_FONT,
                fontSize: 10,
                color: commandError ? COLORS.danger : COLORS.textDim,
                lineHeight: 1.5,
              }}
            >
              {commandError ?? "Quoted args are supported. For shell pipelines or redirects, wrap them in a script or invoke a shell explicitly."}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              color: COLORS.textMuted,
              cursor: "pointer",
              padding: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontFamily: MONO_FONT,
              fontSize: 11,
            }}
          >
            {showAdvanced ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
            More options
          </button>

          {showAdvanced && (
            <>
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
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder={normalizedLaneRoot ?? "."}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button type="button" onClick={handleBrowseCwd} style={outlineButton({ height: 32, padding: "0 10px" })}>
                    Browse
                  </button>
                </div>
              </div>

              <div>
                <label style={labelStyle}>Environment Variables</label>
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={"KEY=value\nANOTHER=value"}
                  rows={3}
                  style={{
                    ...inputStyle,
                    height: "auto",
                    padding: "8px 10px",
                    resize: "vertical",
                    lineHeight: 1.5,
                  }}
                />
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textDim,
                    lineHeight: 1.5,
                  }}
                >
                  One KEY=value per line. FORCE_COLOR=1 is set by default for all processes.
                </div>
              </div>
            </>
          )}

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

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.length ? trimmed : null;
}

function resolveBrowseDefault(cwd: string, laneRootPath: string | null): string | undefined {
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) return laneRootPath ?? undefined;
  if (normalizedCwd.startsWith("/")) return normalizedCwd;
  if (!laneRootPath) return undefined;
  return normalizedCwd === "." ? laneRootPath : `${laneRootPath}/${normalizedCwd}`;
}

function normalizeSelectedCwd(selectedPath: string, laneRootPath: string | null): string {
  const normalizedSelected = normalizePath(selectedPath) ?? selectedPath;
  if (!laneRootPath) return normalizedSelected;
  if (normalizedSelected === laneRootPath) return ".";
  const prefix = `${laneRootPath}/`;
  if (normalizedSelected.startsWith(prefix)) return normalizedSelected.slice(prefix.length) || ".";
  return normalizedSelected;
}
