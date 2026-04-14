import React from "react";
import { X, CaretRight, CaretDown } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, primaryButton, outlineButton } from "../lanes/laneDesignTokens";
import type { ProcessRestartPolicy } from "../../../shared/types";
import type { StackButtonDefinition } from "../../../shared/types";
import { parseCommandLine } from "../../lib/shell";

export type AddCommandInitialValues = {
  name: string;
  command: string;
  stackId: string | null;
  cwd: string;
  env: string;
  autostart: boolean;
  restart: ProcessRestartPolicy;
  gracefulShutdownMs: string;
  dependsOn: string;
  readinessType: "none" | "port" | "logRegex";
  readinessPort: string;
  readinessPattern: string;
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
    autostart: boolean;
    restart: ProcessRestartPolicy;
    gracefulShutdownMs: string;
    dependsOn: string;
    readinessType: "none" | "port" | "logRegex";
    readinessPort: string;
    readinessPattern: string;
  }) => void;
  /** When provided, the dialog operates in "edit" mode with pre-filled values. */
  initialValues?: AddCommandInitialValues | null;
  /** Dialog title override. Defaults to "Add command". */
  title?: string;
  /** Submit button label override. Defaults to "Add command". */
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
  const [autostart, setAutostart] = React.useState(false);
  const [restart, setRestart] = React.useState<ProcessRestartPolicy>("never");
  const [gracefulShutdownMs, setGracefulShutdownMs] = React.useState("7000");
  const [dependsOn, setDependsOn] = React.useState("");
  const [readinessType, setReadinessType] = React.useState<"none" | "port" | "logRegex">("none");
  const [readinessPort, setReadinessPort] = React.useState("");
  const [readinessPattern, setReadinessPattern] = React.useState("");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);

  const dialogTitle = title ?? "Add command";
  const dialogSubmitLabel = submitLabel ?? "Add command";
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
  const readinessError = React.useMemo(() => {
    if (readinessType === "port" && !readinessPort.trim()) return "Readiness port is required.";
    if (readinessType === "logRegex" && !readinessPattern.trim()) return "Readiness pattern is required.";
    return null;
  }, [readinessPattern, readinessPort, readinessType]);

  React.useEffect(() => {
    if (open) {
      if (initialValues) {
        setName(initialValues.name);
        setCommand(initialValues.command);
        setStackId(initialValues.stackId ?? "__none__");
        setCwd(initialValues.cwd || ".");
        setEnvText(initialValues.env || "");
        setAutostart(initialValues.autostart ?? false);
        setRestart(initialValues.restart ?? "never");
        setGracefulShutdownMs(initialValues.gracefulShutdownMs || "7000");
        setDependsOn(initialValues.dependsOn || "");
        setReadinessType(initialValues.readinessType ?? "none");
        setReadinessPort(initialValues.readinessPort || "");
        setReadinessPattern(initialValues.readinessPattern || "");
        // Auto-expand advanced section when editing a command with non-default values
        const hasStack = initialValues.stackId != null;
        const hasCwd = Boolean(initialValues.cwd) && initialValues.cwd !== ".";
        const hasEnv = Boolean(initialValues.env?.trim());
        const hasBehavior =
          initialValues.autostart
          || initialValues.restart !== "never"
          || (initialValues.gracefulShutdownMs || "7000") !== "7000"
          || Boolean(initialValues.dependsOn?.trim())
          || initialValues.readinessType !== "none";
        setShowAdvanced(hasStack || hasCwd || hasEnv || hasBehavior);
      } else {
        setName("");
        setCommand("");
        setStackId("__none__");
        setCwd(".");
        setEnvText("");
        setAutostart(false);
        setRestart("never");
        setGracefulShutdownMs("7000");
        setDependsOn("");
        setReadinessType("none");
        setReadinessPort("");
        setReadinessPattern("");
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

  const canSubmit = Boolean(name.trim() && command.trim() && !commandError && !readinessError);

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
      autostart: showAdvanced ? autostart : false,
      restart: showAdvanced ? restart : "never",
      gracefulShutdownMs: showAdvanced ? gracefulShutdownMs.trim() || "7000" : "7000",
      dependsOn: showAdvanced ? dependsOn.trim() : "",
      readinessType: showAdvanced ? readinessType : "none",
      readinessPort: showAdvanced ? readinessPort.trim() : "",
      readinessPattern: showAdvanced ? readinessPattern.trim() : "",
    });
    onClose();
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 32,
    padding: "0 10px",
    background: COLORS.pageBg,
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
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 0,
          width: 420,
          maxWidth: "90vw",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
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
              {commandError ?? "Runs exactly what you type here. Use a script for pipes, redirects, or multi-step shell logic."}
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
            Advanced runtime options
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
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textDim,
                    lineHeight: 1.5,
                  }}
                >
                  Relative to the lane root. Use `.` to run from the lane root itself.
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

              <div>
                <label style={labelStyle}>Restart Policy</label>
                <select
                  value={restart}
                  onChange={(e) => setRestart(e.target.value as ProcessRestartPolicy)}
                  style={{
                    ...inputStyle,
                    appearance: "none",
                    cursor: "pointer",
                  }}
                >
                  <option value="never">Never restart</option>
                  <option value="on-failure">Restart on failure</option>
                  <option value="always">Always restart</option>
                  <option value="on_crash">Restart on crash</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>Readiness Check</label>
                <select
                  value={readinessType}
                  onChange={(e) => setReadinessType(e.target.value as "none" | "port" | "logRegex")}
                  style={{
                    ...inputStyle,
                    appearance: "none",
                    cursor: "pointer",
                  }}
                >
                  <option value="none">None</option>
                  <option value="port">Port</option>
                  <option value="logRegex">Log pattern</option>
                </select>
              </div>

              {readinessType === "port" ? (
                <div>
                  <label style={labelStyle}>Readiness Port</label>
                  <input
                    value={readinessPort}
                    onChange={(e) => setReadinessPort(e.target.value)}
                    placeholder="e.g. 3000"
                    style={inputStyle}
                  />
                </div>
              ) : null}

              {readinessType === "logRegex" ? (
                <div>
                  <label style={labelStyle}>Readiness Pattern</label>
                  <input
                    value={readinessPattern}
                    onChange={(e) => setReadinessPattern(e.target.value)}
                    placeholder="e.g. ready on http"
                    style={inputStyle}
                  />
                </div>
              ) : null}

              <div>
                <label style={labelStyle}>Graceful Shutdown (ms)</label>
                <input
                  value={gracefulShutdownMs}
                  onChange={(e) => setGracefulShutdownMs(e.target.value)}
                  placeholder="7000"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Depends On</label>
                <input
                  value={dependsOn}
                  onChange={(e) => setDependsOn(e.target.value)}
                  placeholder="comma-separated process ids"
                  style={inputStyle}
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
                  Use process ids, not labels. Dependencies start before this command.
                </div>
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: COLORS.textSecondary,
                  cursor: "pointer",
                }}
              >
                <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
                Start automatically when the lane opens
              </label>

              {readinessError ? (
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.danger,
                    lineHeight: 1.5,
                  }}
                >
                  {readinessError}
                </div>
              ) : null}
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
