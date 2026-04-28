import React from "react";
import { Folder, FolderOpen, Plus, X } from "@phosphor-icons/react";
import type { LaneSummary, ProcessGroupDefinition } from "../../../shared/types";
import { COLORS, LABEL_STYLE, MONO_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { useClickOutside } from "../../hooks/useClickOutside";
import { parseCommandLine } from "../../lib/shell";

export type AddCommandInitialValues = {
  name: string;
  command: string;
  cwd: string;
  env: string;
  autostart: boolean;
  gracefulShutdownMs: string;
  dependsOn: string;
  groupIds: string[];
};

export type AddCommandSubmitPayload = AddCommandInitialValues & {
  newGroupNames: string[];
};

type AddCommandDialogProps = {
  groups: ProcessGroupDefinition[];
  lanes: LaneSummary[];
  defaultLaneId: string | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (cmd: AddCommandSubmitPayload) => void | Promise<void>;
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
      onPointerDown={(event) => {
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
  const [cwd, setCwd] = React.useState(".");
  const [envText, setEnvText] = React.useState("");
  const [autostart, setAutostart] = React.useState(false);
  const [gracefulShutdownMs, setGracefulShutdownMs] = React.useState("7000");
  const [dependsOn, setDependsOn] = React.useState("");
  const [selectedGroupIds, setSelectedGroupIds] = React.useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerLaneId, setPickerLaneId] = React.useState<string | null>(defaultLaneId);
  const [groupPickerOpen, setGroupPickerOpen] = React.useState(false);
  const groupPickerRef = React.useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const nameFieldId = React.useId();
  const commandFieldId = React.useId();

  const assignedGroups = React.useMemo(
    () => groups.filter((group) => selectedGroupIds.includes(group.id)),
    [groups, selectedGroupIds],
  );
  const availableGroups = React.useMemo(
    () => groups.filter((group) => !selectedGroupIds.includes(group.id)),
    [groups, selectedGroupIds],
  );

  useClickOutside(groupPickerRef, () => setGroupPickerOpen(false), groupPickerOpen);

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

  React.useEffect(() => {
    if (!open) return;
    const values = initialValues;
    if (values) {
      setName(values.name);
      setCommand(values.command);
      setCwd(values.cwd || ".");
      setEnvText(values.env || "");
      setAutostart(values.autostart ?? false);
      setGracefulShutdownMs(values.gracefulShutdownMs || "7000");
      setDependsOn(values.dependsOn || "");
      setSelectedGroupIds(values.groupIds ?? []);
    } else {
      setName("");
      setCommand("");
      setCwd(".");
      setEnvText("");
      setAutostart(false);
      setGracefulShutdownMs("7000");
      setDependsOn("");
      setSelectedGroupIds([]);
    }
    setPickerLaneId(defaultLaneId);
    setSubmitting(false);
    setSubmitError(null);
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

  const removeFromGroup = (groupId: string) => {
    setSelectedGroupIds((current) => current.filter((id) => id !== groupId));
  };

  const addToGroup = (groupId: string) => {
    setSelectedGroupIds((current) => (current.includes(groupId) ? current : [...current, groupId]));
    setGroupPickerOpen(false);
  };

  const canSubmit = Boolean(name.trim() && command.trim() && !commandError && !submitting);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        name: name.trim(),
        command: command.trim(),
        cwd: normalizeRelativeCwd(cwd),
        env: envText.trim(),
        autostart,
        gracefulShutdownMs: gracefulShutdownMs.trim() || "7000",
        dependsOn: dependsOn.trim(),
        groupIds: selectedGroupIds,
        newGroupNames: [],
      });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
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
        data-testid="add-command-dialog-backdrop"
        onPointerDown={(event) => {
          if (!submitting && event.target === event.currentTarget) onClose();
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
              disabled={submitting}
              style={{
                background: "transparent",
                border: "none",
                color: COLORS.textMuted,
                cursor: submitting ? "default" : "pointer",
                padding: 2,
                display: "flex",
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <X size={16} weight="bold" />
            </button>
          </div>

          <form onSubmit={handleSubmit} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label htmlFor={nameFieldId} style={labelStyle} aria-label="Name, required">
                Name{" "}
                <span style={{ color: COLORS.danger }} aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id={nameFieldId}
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Dev server"
                style={inputStyle}
                disabled={submitting}
                required
                aria-required="true"
              />
            </div>

            <div>
              <label htmlFor={commandFieldId} style={labelStyle} aria-label="Command, required">
                Command{" "}
                <span style={{ color: COLORS.danger }} aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id={commandFieldId}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="e.g. npm run dev"
                style={inputStyle}
                disabled={submitting}
                required
                aria-required="true"
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

            <div>
              <label style={labelStyle}>Working directory</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                <input
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  style={inputStyle}
                  disabled={submitting}
                />
                <button type="button" onClick={() => setPickerOpen(true)} disabled={submitting} style={outlineButton({ height: 32, opacity: submitting ? 0.5 : 1 })}>
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
                disabled={submitting}
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
              <label style={labelStyle}>Graceful shutdown (ms)</label>
              <input
                value={gracefulShutdownMs}
                onChange={(event) => setGracefulShutdownMs(event.target.value)}
                placeholder="7000"
                style={inputStyle}
                disabled={submitting}
              />
            </div>

            <div>
              <label style={labelStyle}>Depends on</label>
              <input
                value={dependsOn}
                onChange={(event) => setDependsOn(event.target.value)}
                placeholder="comma-separated process ids"
                style={inputStyle}
                disabled={submitting}
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
              <input type="checkbox" checked={autostart} onChange={(event) => setAutostart(event.target.checked)} disabled={submitting} />
              Start automatically when the lane opens
            </label>

            <div>
              <label style={labelStyle}>Groups</label>
              <div
                style={{
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.pageBg,
                  padding: "10px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 10,
                      fontWeight: 600,
                      color: COLORS.textDim,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      marginBottom: 6,
                    }}
                  >
                    In these groups
                  </div>
                  {assignedGroups.length === 0 ? (
                    <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
                      Not in any group yet.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      {assignedGroups.map((group) => (
                        <span
                          key={group.id}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontFamily: MONO_FONT,
                            fontSize: 10,
                            color: COLORS.textSecondary,
                            background: COLORS.cardBgSolid,
                            border: `1px solid ${COLORS.border}`,
                            padding: "2px 4px 2px 8px",
                          }}
                        >
                          <span>{group.name}</span>
                          <button
                            type="button"
                            title={`Remove from ${group.name}`}
                            aria-label={`Remove from ${group.name}`}
                            disabled={submitting}
                            onClick={() => removeFromGroup(group.id)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "transparent",
                              border: "none",
                              padding: 2,
                              cursor: submitting ? "default" : "pointer",
                              color: COLORS.textMuted,
                              opacity: submitting ? 0.45 : 1,
                            }}
                          >
                            <X size={12} weight="bold" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {groups.length > 0 ? (
                  <div ref={groupPickerRef} style={{ position: "relative", alignSelf: "flex-start" }}>
                    <button
                      type="button"
                      title={availableGroups.length === 0 ? "Already in every group" : "Add to another group"}
                      disabled={submitting || availableGroups.length === 0}
                      onClick={() => availableGroups.length > 0 && setGroupPickerOpen((open) => !open)}
                      style={{
                        ...outlineButton({ height: 26, padding: "0 10px", fontSize: 10 }),
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        opacity: submitting || availableGroups.length === 0 ? 0.45 : 1,
                        cursor: submitting || availableGroups.length === 0 ? "default" : "pointer",
                      }}
                    >
                      <Plus size={12} weight="bold" />
                      Add to group
                    </button>
                    {groupPickerOpen && availableGroups.length > 0 ? (
                      <div
                        style={{
                          position: "absolute",
                          top: "100%",
                          left: 0,
                          marginTop: 4,
                          zIndex: 60,
                          minWidth: 180,
                          maxHeight: 220,
                          overflowY: "auto",
                          padding: "4px 0",
                          background: COLORS.cardBgSolid,
                          border: `1px solid ${COLORS.border}`,
                          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                        }}
                      >
                        {availableGroups.map((group) => (
                          <button
                            key={group.id}
                            type="button"
                            onClick={() => addToGroup(group.id)}
                            style={{
                              display: "block",
                              width: "100%",
                              textAlign: "left",
                              background: "transparent",
                              border: "none",
                              padding: "7px 12px",
                              fontFamily: MONO_FONT,
                              fontSize: 11,
                              fontWeight: 600,
                              color: COLORS.textSecondary,
                              cursor: "pointer",
                            }}
                            onMouseEnter={(event) => {
                              event.currentTarget.style.background = COLORS.hoverBg;
                            }}
                            onMouseLeave={(event) => {
                              event.currentTarget.style.background = "transparent";
                            }}
                          >
                            {group.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {submitError ? (
              <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger, lineHeight: 1.5 }}>
                {submitError}
              </div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
              <button type="button" onClick={onClose} disabled={submitting} style={outlineButton({ opacity: submitting ? 0.5 : 1 })}>
                Cancel
              </button>
              <button type="submit" disabled={!canSubmit} style={primaryButton({ opacity: canSubmit ? 1 : 0.5 })}>
                {submitting ? "Saving..." : dialogSubmitLabel}
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
