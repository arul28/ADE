import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { COLORS, MONO_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import type { NewLaneBaseSource } from "../../../shared/types";
import { DEFAULT_NEW_LANE_BASE_SOURCE, effectiveNewLaneBaseSource } from "../lanes/newLaneBaseSource";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function LaneBehaviorSection() {
  const navigate = useNavigate();
  const [autoRebaseDraft, setAutoRebaseDraft] = useState(false);
  const [newLaneBaseSource, setNewLaneBaseSource] = useState<NewLaneBaseSource>(DEFAULT_NEW_LANE_BASE_SOURCE);
  const [initialNewLaneBaseSource, setInitialNewLaneBaseSource] =
    useState<NewLaneBaseSource>(DEFAULT_NEW_LANE_BASE_SOURCE);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const snapshot = await window.ade.projectConfig.get();
    const localAutoRebase =
      typeof snapshot.local.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.local.git.autoRebaseOnHeadChange : null;
    const effectiveAutoRebase =
      typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean"
        ? snapshot.effective.git.autoRebaseOnHeadChange
        : null;
    setAutoRebaseDraft(localAutoRebase ?? effectiveAutoRebase ?? false);
    const initialSource = effectiveNewLaneBaseSource(snapshot);
    setNewLaneBaseSource(initialSource);
    setInitialNewLaneBaseSource(initialSource);

  };

  useEffect(() => {
    void refresh().catch(() => {});
  }, []);

  const saveSettings = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const snapshot = await window.ade.projectConfig.get();
      const currentGit = isRecord(snapshot.local.git) ? snapshot.local.git : {};
      const hasLocalNewLaneBaseSource =
        currentGit.newLaneBaseSource === "local" || currentGit.newLaneBaseSource === "remote";
      const sourceDiffersFromInitial = newLaneBaseSource !== initialNewLaneBaseSource;
      const nextGit = {
        ...currentGit,
        autoRebaseOnHeadChange: autoRebaseDraft,
      };
      if (sourceDiffersFromInitial || hasLocalNewLaneBaseSource) {
        nextGit.newLaneBaseSource = newLaneBaseSource;
      } else {
        delete nextGit.newLaneBaseSource;
      }
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          git: nextGit,
        },
      });
      await refresh();
      setNotice("Settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const messageStyle = (color: string): CSSProperties => ({
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color,
    background: `${color}12`,
    border: `1px solid ${color}30`,
    borderRadius: 8,
  });

  return (
    <section style={{ padding: 16 }}>
      <div style={{ ...LABEL_STYLE, fontSize: 11, marginBottom: 8 }}>LANE BEHAVIOR</div>
      <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 16 }}>
        Choose how new lanes start and how stacked lanes stay current. Storage rules now live in Storage.
      </div>

      {notice ? <div style={{ ...messageStyle(COLORS.success), marginBottom: 12 }}>{notice}</div> : null}
      {error ? <div style={{ ...messageStyle(COLORS.danger), marginBottom: 12 }}>{error}</div> : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* New lane base */}
        <div style={cardStyle({ borderRadius: 12 })}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>New lane base</div>
            <div style={{ marginTop: 4, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
              Choose whether new root lanes and chat auto-created lanes start from the fetched remote branch or your local branch tip.
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(["remote", "local"] as const).map((source) => {
              const active = newLaneBaseSource === source;
              return (
                <button
                  key={source}
                  type="button"
                  onClick={() => {
                    if (source === newLaneBaseSource) return;
                    setNewLaneBaseSource(source);
                  }}
                  style={{
                    ...outlineButton({ height: 56, padding: "8px 10px", borderRadius: 8 }),
                    justifyContent: "flex-start",
                    textAlign: "left",
                    borderColor: active ? COLORS.accent : COLORS.outlineBorder,
                    background: active ? `${COLORS.accent}12` : COLORS.recessedBg,
                    color: active ? COLORS.textPrimary : COLORS.textMuted,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{source === "remote" ? "Remote" : "Local"}</div>
                    <div style={{ marginTop: 2, fontSize: 10, color: COLORS.textDim }}>
                      {source === "remote" ? "Start from fetched upstream" : "Start from local branch"}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Auto-rebase */}
        <div style={cardStyle({ borderRadius: 12 })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>Auto-rebase child lanes</div>
              <div style={{ marginTop: 4, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
                Rebase dependent lanes when a parent advances. Keeps stacks aligned automatically.
              </div>
            </div>
            <ToggleSwitch checked={autoRebaseDraft} onChange={setAutoRebaseDraft} />
          </div>
        </div>

        {/* Save + Open Rebase/Merge tab */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            style={outlineButton({ height: 32 })}
            disabled={busy}
            onClick={() => navigate("/prs?tab=workflows&workflow=rebase")}
          >
            Open Rebase/Merge tab
          </button>
          <button type="button" style={primaryButton({ height: 32 })} disabled={busy} onClick={() => void saveSettings()}>
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Toggle switch
// ---------------------------------------------------------------------------

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 40,
        height: 22,
        border: "none",
        padding: 0,
        borderRadius: 11,
        background: checked ? COLORS.accent : COLORS.border,
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 150ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          background: checked ? COLORS.pageBg : COLORS.textMuted,
          borderRadius: 9,
          transition: "left 150ms ease",
        }}
      />
    </button>
  );
}
