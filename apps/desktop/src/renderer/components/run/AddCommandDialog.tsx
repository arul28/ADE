import React from "react";
import { CaretDown, CaretRight, Folder, FolderOpen, X } from "@phosphor-icons/react";
import type { LaneSummary, ProcessGroupDefinition, ProcessRestartPolicy, StackButtonDefinition } from "../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
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
  groupIds: string[];
};

type AddCommandSubmitArgs = {
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
  groupIds: string[];
  newGroupNames: string[];
};

type AddCommandDialogProps = {
  stacks: StackButtonDefinition[];
  groups: ProcessGroupDefinition[];
  lanes: LaneSummary[];
  defaultLaneId: string | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (cmd: AddCommandSubmitArgs) => void;
  initialValues?: AddCommandInitialValues | null;
  title?: string;
  submitLabel?: string;
};

function normalizeRelativeCwd(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "." || trimmed === "./") return ".";
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return normalized || ".";
  return normalized.replace(/^\.\/+/, "") || ".";
}

function browseInputFromRelativePath(value: string): string {
  const normalized = normalizeRelativeCwd(value);
  return normalized === "." ? "." : `./${normalized}`;
}

function relativePathWithinRoot(rootPath: string, fullPath: string): string | null {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = normalize(rootPath);
  const normalizedFull = normalize(fullPath);
  if (normalizedFull === normalizedRoot) return ".";
  if (!normalizedFull.startsWith(`${normalizedRoot}/`)) return null;
  return normalizedFull.slice(normalizedRoot.length + 1) || ".";
}

function parentRelativePath(value: string): string {
  const normalized = normalizeRelativeCwd(value);
  if (normalized === ".") return ".";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

type DirectoryPickerDialogProps = {
  open: boolean;
  lanes: LaneSummary[];
  initialLaneId: string | null;
  initialPath: string;
  onClose: () => void;
  onPick: (value: { laneId: string; path: string }) => void;
};

function DirectoryPickerDialog({
  open,
  lanes,
  initialLaneId,
  initialPath,
  onClose,
  onPick,
}: DirectoryPickerDialogProps) {
  const [laneId, setLaneId] = React.useState(initialLaneId ?? lanes[0]?.id ?? "");
  const [currentPath, setCurrentPath] = React.useState(normalizeRelativeCwd(initialPath));
  const [typedPath, setTypedPath] = React.useState(normalizeRelativeCwd(initialPath));
  const [entries, setEntries] = React.useState<Array<{ name: string; path: string }>>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const lane = React.useMemo(() => lanes.find((item) => item.id === laneId) ?? null, [laneId, lanes]);

  React.useEffect(() => {
    if (!open) return;
    setLaneId(initialLaneId ?? lanes[0]?.id ?? "");
    const normalized = normalizeRelativeCwd(initialPath);
    setCurrentPath(normalized);
    setTypedPath(normalized);
    setEntries([]);
    setError(null);
  }, [initialLaneId, initialPath, lanes, open]);

  React.useEffect(() => {
    if (!open || !lane?.worktreePath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.ade.project
      .browseDirectories({
        cwd: lane.worktreePath,
        partialPath: browseInputFromRelativePath(currentPath),
        limit: 200,
      })
      .then((result) => {
        if (cancelled) return;
        const nextEntries = result.entries
          .map((entry) => {
            const relative = relativePathWithinRoot(lane.worktreePath, entry.fullPath);
            if (!relative) return null;
            return {
              name: entry.name,
              path: normalizeRelativeCwd(relative),
            };
          })
          .filter((entry): entry is { name: string; path: string } => entry != null)
          .sort((left, right) => left.name.localeCompare(right.name));
        setEntries(nextEntries);
      })
      .catch((browseError) => {
        if (cancelled) return;
        setEntries([]);
        setError(browseError instanceof Error ? browseError.message : String(browseError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath, lane?.worktreePath, open]);

  if (!open) return null;

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

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 260,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "92vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.border}`,
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        }}
      >
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
            Choose working directory
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

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 10 }}>
            <label style={{ ...LABEL_STYLE, marginBottom: 0, alignSelf: "center" }}>Lane</label>
            <select
              value={laneId}
              onChange={(event) => {
                setLaneId(event.target.value);
                setCurrentPath(".");
                setTypedPath(".");
              }}
              style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
            >
              {lanes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "150px 1fr auto auto", gap: 10, alignItems: "center" }}>
            <label style={{ ...LABEL_STYLE, marginBottom: 0 }}>Directory</label>
            <input
              value={typedPath}
              onChange={(event) => setTypedPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const nextPath = normalizeRelativeCwd(typedPath);
                  setCurrentPath(nextPath);
                  setTypedPath(nextPath);
                }
              }}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={() => {
                const nextPath = normalizeRelativeCwd(typedPath);
                setCurrentPath(nextPath);
                setTypedPath(nextPath);
              }}
              style={outlineButton({ height: 32, padding: "0 12px" })}
            >
              Go
            </button>
            <button
              type="button"
              onClick={() => {
                const nextPath = parentRelativePath(currentPath);
                setCurrentPath(nextPath);
                setTypedPath(nextPath);
              }}
              disabled={currentPath === "."}
              style={{
                ...outlineButton({ height: 32, padding: "0 12px" }),
                opacity: currentPath === "." ? 0.45 : 1,
                cursor: currentPath === "." ? "default" : "pointer",
              }}
            >
              Up
            </button>
          </div>

          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              background: COLORS.pageBg,
              minHeight: 220,
              maxHeight: 320,
              overflowY: "auto",
            }}
          >
            {loading ? (
              <div style={{ padding: 16, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>
                Loading folders...
              </div>
            ) : error ? (
              <div style={{ padding: 16, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger }}>{error}</div>
            ) : entries.length === 0 ? (
              <div style={{ padding: 16, fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim }}>
                No subdirectories found here.
              </div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    setCurrentPath(entry.path);
                    setTypedPath(entry.path);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    background: entry.path === currentPath ? COLORS.hoverBg : "transparent",
                    border: "none",
                    borderBottom: `1px solid ${COLORS.border}`,
                    color: COLORS.textPrimary,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                  }}
                >
                  <Folder size={14} weight="regular" />
                  <span>{entry.path}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            padding: 16,
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textDim, alignSelf: "center" }}>
            Paths are stored relative to the lane root.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} style={outlineButton({ height: 32, padding: "0 14px" })}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onPick({ laneId, path: normalizeRelativeCwd(currentPath) })}
              style={primaryButton({ height: 32, padding: "0 14px" })}
            >
              <FolderOpen size={14} weight="bold" />
              Use folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AddCommandDialog({
  stacks,
  groups,
  lanes,
  defaultLaneId,
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
  const [envText, setEnvText] = React.useState("");
  const [autostart, setAutostart] = React.useState(false);
  const [restart, setRestart] = React.useState<ProcessRestartPolicy>("never");
  const [gracefulShutdownMs, setGracefulShutdownMs] = React.useState("7000");
  const [dependsOn, setDependsOn] = React.useState("");
  const [readinessType, setReadinessType] = React.useState<"none" | "port" | "logRegex">("none");
  const [readinessPort, setReadinessPort] = React.useState("");
  const [readinessPattern, setReadinessPattern] = React.useState("");
  const [selectedGroupIds, setSelectedGroupIds] = React.useState<string[]>([]);
  const [newGroupNames, setNewGroupNames] = React.useState("");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerLaneId, setPickerLaneId] = React.useState<string | null>(defaultLaneId);
  const nameRef = React.useRef<HTMLInputElement>(null);

  const dialogTitle = title ?? "Add command";
  const dialogSubmitLabel = submitLabel ?? "Add command";
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
  const newStackNameError = showAdvanced && stackId === "__new__" && !newStackName.trim()
    ? "New stack name is required."
    : null;
  const readinessError = React.useMemo(() => {
    if (!showAdvanced) return null;
    if (readinessType === "port" && !readinessPort.trim()) return "Readiness port is required.";
    if (readinessType === "logRegex" && !readinessPattern.trim()) return "Readiness pattern is required.";
    return null;
  }, [readinessPattern, readinessPort, readinessType, showAdvanced]);

  React.useEffect(() => {
    if (!open) return;
    const values = initialValues;
    if (values) {
      setName(values.name);
      setCommand(values.command);
      setStackId(values.stackId ?? "__none__");
      setCwd(values.cwd || ".");
      setEnvText(values.env || "");
      setAutostart(values.autostart ?? false);
      setRestart(values.restart ?? "never");
      setGracefulShutdownMs(values.gracefulShutdownMs || "7000");
      setDependsOn(values.dependsOn || "");
      setReadinessType(values.readinessType ?? "none");
      setReadinessPort(values.readinessPort || "");
      setReadinessPattern(values.readinessPattern || "");
      setSelectedGroupIds(values.groupIds ?? []);
      setShowAdvanced(
        Boolean(values.stackId)
        || Boolean(values.cwd && values.cwd !== ".")
        || Boolean(values.env?.trim())
        || Boolean(values.autostart)
        || (values.restart ?? "never") !== "never"
        || (values.gracefulShutdownMs || "7000") !== "7000"
        || Boolean(values.dependsOn?.trim())
        || (values.readinessType ?? "none") !== "none"
        || (values.groupIds?.length ?? 0) > 0,
      );
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
      setSelectedGroupIds([]);
      setShowAdvanced(false);
    }
    setNewStackName("");
    setNewGroupNames("");
    setPickerLaneId(defaultLaneId);
    window.setTimeout(() => nameRef.current?.focus(), 50);
  }, [defaultLaneId, initialValues, open]);

  if (!open) return null;

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

  const toggleGroup = (groupId: string) => {
    setSelectedGroupIds((current) =>
      current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
    );
  };

  const canSubmit = Boolean(name.trim() && command.trim() && !commandError && !newStackNameError && !readinessError);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      command: command.trim(),
      stackId: showAdvanced ? (stackId === "__none__" || stackId === "__new__" ? null : stackId) : null,
      newStackName: showAdvanced && stackId === "__new__" ? newStackName.trim() || null : null,
      cwd: showAdvanced ? normalizeRelativeCwd(cwd) : ".",
      env: showAdvanced ? envText.trim() : "",
      autostart: showAdvanced ? autostart : false,
      restart: showAdvanced ? restart : "never",
      gracefulShutdownMs: showAdvanced ? gracefulShutdownMs.trim() || "7000" : "7000",
      dependsOn: showAdvanced ? dependsOn.trim() : "",
      readinessType: showAdvanced ? readinessType : "none",
      readinessPort: showAdvanced ? readinessPort.trim() : "",
      readinessPattern: showAdvanced ? readinessPattern.trim() : "",
      groupIds: showAdvanced ? selectedGroupIds : [],
      newGroupNames: showAdvanced
        ? newGroupNames
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [],
    });
    onClose();
  };

  return (
    <>
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
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          style={{
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.border}`,
            width: 460,
            maxWidth: "92vw",
            maxHeight: "88vh",
            overflowY: "auto",
            boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
          }}
        >
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

          <form onSubmit={handleSubmit} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={labelStyle}>Name</label>
              <input
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Dev server"
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>Command</label>
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="e.g. npm run dev"
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
                {commandError ?? "ADE runs exactly what you type here. Use a script when you need multi-step shell logic."}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
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
              Launch options
            </button>

            {showAdvanced ? (
              <>
                <div>
                  <label style={labelStyle}>Stack</label>
                  <select
                    value={stackId}
                    onChange={(event) => setStackId(event.target.value)}
                    style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
                  >
                    <option value="__none__">No stack</option>
                    {stacks.map((stack) => (
                      <option key={stack.id} value={stack.id}>
                        {stack.name}
                      </option>
                    ))}
                    <option value="__new__">+ New stack...</option>
                  </select>
                </div>

                {stackId === "__new__" ? (
                  <div>
                    <label style={labelStyle}>New stack name</label>
                    <input
                      value={newStackName}
                      onChange={(event) => setNewStackName(event.target.value)}
                      placeholder="e.g. SST dev"
                      style={{
                        ...inputStyle,
                        border: `1px solid ${newStackNameError ? COLORS.danger : COLORS.outlineBorder}`,
                      }}
                    />
                    {newStackNameError ? (
                      <div style={{ marginTop: 6, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.danger }}>
                        {newStackNameError}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div>
                  <label style={labelStyle}>Working directory</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                    <input value={cwd} onChange={(event) => setCwd(event.target.value)} style={inputStyle} />
                    <button type="button" onClick={() => setPickerOpen(true)} style={outlineButton({ height: 32 })}>
                      <FolderOpen size={14} weight="bold" />
                      Browse
                    </button>
                  </div>
                  <div style={{ marginTop: 6, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                    Stored relative to the lane root. If another lane does not have this folder yet, the command can still
                    save and will fail only when you launch it there.
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Environment</label>
                  <textarea
                    value={envText}
                    onChange={(event) => setEnvText(event.target.value)}
                    placeholder={"KEY=value\nANOTHER=value"}
                    rows={4}
                    style={{
                      ...inputStyle,
                      height: "auto",
                      minHeight: 88,
                      padding: 10,
                      resize: "vertical",
                    }}
                  />
                </div>

                <div>
                  <label style={labelStyle}>Restart policy</label>
                  <select
                    value={restart}
                    onChange={(event) => setRestart(event.target.value as ProcessRestartPolicy)}
                    style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
                  >
                    <option value="never">Never restart</option>
                    <option value="on-failure">Restart on failure</option>
                    <option value="always">Always restart</option>
                    <option value="on_crash">Restart on crash</option>
                  </select>
                </div>

                <div>
                  <label style={labelStyle}>Readiness check</label>
                  <select
                    value={readinessType}
                    onChange={(event) => setReadinessType(event.target.value as "none" | "port" | "logRegex")}
                    style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
                  >
                    <option value="none">None</option>
                    <option value="port">Port</option>
                    <option value="logRegex">Log pattern</option>
                  </select>
                </div>

                {readinessType === "port" ? (
                  <div>
                    <label style={labelStyle}>Readiness port</label>
                    <input
                      value={readinessPort}
                      onChange={(event) => setReadinessPort(event.target.value)}
                      placeholder="e.g. 3000"
                      style={inputStyle}
                    />
                  </div>
                ) : null}

                {readinessType === "logRegex" ? (
                  <div>
                    <label style={labelStyle}>Readiness pattern</label>
                    <input
                      value={readinessPattern}
                      onChange={(event) => setReadinessPattern(event.target.value)}
                      placeholder="e.g. ready on http"
                      style={inputStyle}
                    />
                  </div>
                ) : null}

                <div>
                  <label style={labelStyle}>Graceful shutdown (ms)</label>
                  <input
                    value={gracefulShutdownMs}
                    onChange={(event) => setGracefulShutdownMs(event.target.value)}
                    placeholder="7000"
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label style={labelStyle}>Depends on</label>
                  <input
                    value={dependsOn}
                    onChange={(event) => setDependsOn(event.target.value)}
                    placeholder="comma-separated process ids"
                    style={inputStyle}
                  />
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
                  <input type="checkbox" checked={autostart} onChange={(event) => setAutostart(event.target.checked)} />
                  Start automatically when the lane opens
                </label>

                {readinessError ? (
                  <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.danger }}>
                    {readinessError}
                  </div>
                ) : null}

                <div>
                  <label style={labelStyle}>Groups</label>
                  {groups.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                      {groups.map((group) => {
                        const active = selectedGroupIds.includes(group.id);
                        return (
                          <button
                            key={group.id}
                            type="button"
                            onClick={() => toggleGroup(group.id)}
                            style={{
                              height: 28,
                              padding: "0 10px",
                              background: active ? COLORS.accentSubtle : COLORS.recessedBg,
                              border: `1px solid ${active ? COLORS.accentBorder : COLORS.outlineBorder}`,
                              color: active ? COLORS.textPrimary : COLORS.textSecondary,
                              cursor: "pointer",
                              fontFamily: MONO_FONT,
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            }}
                          >
                            {group.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <input
                    value={newGroupNames}
                    onChange={(event) => setNewGroupNames(event.target.value)}
                    placeholder="New groups, comma separated"
                    style={inputStyle}
                  />
                </div>
              </>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
              <button type="button" onClick={onClose} style={outlineButton()}>
                Cancel
              </button>
              <button type="submit" disabled={!canSubmit} style={primaryButton({ opacity: canSubmit ? 1 : 0.5 })}>
                {dialogSubmitLabel}
              </button>
            </div>
          </form>
        </div>
      </div>

      <DirectoryPickerDialog
        open={pickerOpen}
        lanes={lanes}
        initialLaneId={pickerLaneId}
        initialPath={cwd}
        onClose={() => setPickerOpen(false)}
        onPick={({ laneId, path }) => {
          setPickerLaneId(laneId);
          setCwd(path);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
