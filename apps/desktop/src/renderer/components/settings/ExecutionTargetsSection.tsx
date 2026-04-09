import React, { useCallback, useId, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import type { AdeExecutionTargetsState, AdeSshExecutionTargetProfile } from "../../../shared/types";
import {
  ADE_LOCAL_EXECUTION_TARGET_ID,
  defaultExecutionTargetsState,
  executionTargetSummaryLabel,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useExecutionTargets } from "../../hooks/useExecutionTargets";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const FIELD: React.CSSProperties = {
  height: 28,
  width: "100%",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  padding: "0 8px",
  fontSize: 11,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  borderRadius: 8,
  outline: "none",
};

const FIELD_LABEL: React.CSSProperties = {
  fontFamily: SANS_FONT,
  fontSize: 10,
  color: COLORS.textMuted,
};

export function ExecutionTargetsSection() {
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const { state, persist } = useExecutionTargets(projectRoot);
  const fieldPrefix = useId();
  const [label, setLabel] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [workspacePath, setWorkspacePath] = useState("~/project");
  const [jumpHost, setJumpHost] = useState("");
  const [mode, setMode] = useState<AdeSshExecutionTargetProfile["connectionMode"]>("planned");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveState = useCallback(
    async (next: AdeExecutionTargetsState): Promise<boolean> => {
      setSaveError(null);
      setBusy(true);
      try {
        await persist(next);
        return true;
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [persist],
  );

  const addSshTarget = useCallback(async () => {
    const trimmedLabel = label.trim();
    const host = sshHost.trim();
    const ws = workspacePath.trim();
    if (!trimmedLabel || !host || !ws) return;
    const id =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const nextProfile: AdeSshExecutionTargetProfile = {
      id,
      kind: "ssh",
      label: trimmedLabel,
      sshHost: host,
      workspacePath: ws,
      ...(jumpHost.trim() ? { jumpHost: jumpHost.trim() } : {}),
      connectionMode: mode,
    };
    const next: AdeExecutionTargetsState = {
      ...state,
      profiles: [...state.profiles.filter((p) => p.id !== id), nextProfile],
    };
    const saved = await saveState(next);
    if (!saved) return;
    setLabel("");
    setSshHost("");
    setJumpHost("");
  }, [jumpHost, label, mode, saveState, sshHost, state, workspacePath]);

  const removeTarget = useCallback(
    async (id: string) => {
      if (id === ADE_LOCAL_EXECUTION_TARGET_ID) return;
      const next: AdeExecutionTargetsState = {
        ...state,
        profiles: state.profiles.filter((p) => p.id !== id),
        activeTargetId: state.activeTargetId === id ? ADE_LOCAL_EXECUTION_TARGET_ID : state.activeTargetId,
      };
      if (!next.profiles.some((p) => p.id === ADE_LOCAL_EXECUTION_TARGET_ID)) {
        next.profiles = defaultExecutionTargetsState().profiles;
      }
      await saveState(next);
    },
    [saveState, state],
  );

  if (!projectRoot?.trim()) {
    return (
      <div style={{ ...cardStyle({ padding: 16 }), color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
        Open a project to configure execution targets.
      </div>
    );
  }

  return (
    <div id="execution-targets" style={{ maxWidth: 640 }}>
      <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Execution targets</div>
      <p style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted, marginBottom: 16, lineHeight: 1.5 }}>
        Choose where this project&apos;s workspace focus points. Chats can record a target for when remote execution is
        available; tools still run on this computer until SSH or a remote runner is connected.
      </p>
      {saveError ? (
        <div
          role="alert"
          style={{
            ...cardStyle({ padding: 12 }),
            marginBottom: 12,
            borderColor: "rgba(239,68,68,0.25)",
            color: COLORS.danger,
            fontFamily: SANS_FONT,
            fontSize: 11,
          }}
        >
          Couldn&apos;t save execution target changes. {saveError}
        </div>
      ) : null}

      <div style={{ ...cardStyle({ padding: 12 }), marginBottom: 12 }}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 8 }}>
          Saved targets
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {state.profiles.map((p) => (
            <li
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 0",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                fontFamily: SANS_FONT,
                fontSize: 11,
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: COLORS.textPrimary }}>{executionTargetSummaryLabel(p)}</span>
                {p.kind === "ssh" ? (
                  <span style={{ display: "block", color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10 }}>
                    {p.sshHost} → {p.workspacePath}
                  </span>
                ) : null}
              </span>
              {p.id === state.activeTargetId ? (
                <span style={{ fontSize: 9, textTransform: "uppercase", color: COLORS.accent }}>Active</span>
              ) : (
                <button
                  type="button"
                  style={outlineButton({ height: 24, padding: "0 8px", fontSize: 9 })}
                  onClick={() => void saveState({ ...state, activeTargetId: p.id })}
                  disabled={busy}
                >
                  Use
                </button>
              )}
              {p.id !== ADE_LOCAL_EXECUTION_TARGET_ID ? (
                <button
                  type="button"
                  style={{ ...outlineButton({ height: 24, padding: "0 6px", fontSize: 9 }), color: COLORS.danger }}
                  title="Remove target"
                  aria-label={`Remove target ${executionTargetSummaryLabel(p)}`}
                  onClick={() => void removeTarget(p.id)}
                  disabled={busy}
                >
                  <Trash size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ ...cardStyle({ padding: 12 }) }}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 8 }}>
          Add SSH target
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <label htmlFor={`${fieldPrefix}-label`} style={FIELD_LABEL}>
            Display name
          </label>
          <input
            id={`${fieldPrefix}-label`}
            style={FIELD}
            placeholder="Display name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label htmlFor={`${fieldPrefix}-ssh-host`} style={FIELD_LABEL}>
            SSH destination
          </label>
          <input
            id={`${fieldPrefix}-ssh-host`}
            style={FIELD}
            placeholder="SSH destination (user@host)"
            value={sshHost}
            onChange={(e) => setSshHost(e.target.value)}
          />
          <label htmlFor={`${fieldPrefix}-workspace-path`} style={FIELD_LABEL}>
            Remote workspace path
          </label>
          <input
            id={`${fieldPrefix}-workspace-path`}
            style={FIELD}
            placeholder="Remote workspace path"
            value={workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
          />
          <label htmlFor={`${fieldPrefix}-jump-host`} style={FIELD_LABEL}>
            Jump host
          </label>
          <input
            id={`${fieldPrefix}-jump-host`}
            style={FIELD}
            placeholder="Jump host (optional)"
            value={jumpHost}
            onChange={(e) => setJumpHost(e.target.value)}
          />
          <label style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted }}>
            Connection mode{" "}
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as AdeSshExecutionTargetProfile["connectionMode"])}
              style={{ ...FIELD, marginTop: 4, height: 30 }}
            >
              <option value="planned">Planned — metadata only</option>
              <option value="ssh-shell">SSH shell (when implemented)</option>
              <option value="ade-runner">ADE runner on host (when implemented)</option>
            </select>
          </label>
          <button
            type="button"
            style={primaryButton({ height: 30, padding: "0 12px", fontSize: 11 })}
            onClick={() => void addSshTarget()}
            disabled={busy || !label.trim() || !sshHost.trim() || !workspacePath.trim()}
          >
            <Plus size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />
            Add target
          </button>
        </div>
      </div>
    </div>
  );
}
