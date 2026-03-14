import { useEffect, useState, type CSSProperties } from "react";
import { COLORS, MONO_FONT, LABEL_STYLE, cardStyle, primaryButton } from "../lanes/laneDesignTokens";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function LaneBehaviorSection() {
  const [autoRebaseDraft, setAutoRebaseDraft] = useState(false);
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
  };

  useEffect(() => {
    void refresh().catch(() => {});
  }, []);

  const saveAutoRebaseSettings = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const snapshot = await window.ade.projectConfig.get();
      const currentGit = isRecord(snapshot.local.git) ? snapshot.local.git : {};
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          git: {
            ...currentGit,
            autoRebaseOnHeadChange: autoRebaseDraft,
          },
        },
      });
      await refresh();
      setNotice("Lane behavior saved.");
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
  });

  return (
    <section style={{ padding: 16 }}>
      <div style={{ ...LABEL_STYLE, fontSize: 11, marginBottom: 16 }}>LANE BEHAVIOR</div>
      {notice ? <div style={{ ...messageStyle(COLORS.success), marginBottom: 12 }}>{notice}</div> : null}
      {error ? <div style={{ ...messageStyle(COLORS.danger), marginBottom: 12 }}>{error}</div> : null}
      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>Auto-rebase child lanes</div>
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              When enabled, ADE rebases dependent lanes after a parent advances. This keeps stacks aligned without manual cleanup.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAutoRebaseDraft((current) => !current)}
            style={{
              position: "relative",
              width: 48,
              height: 26,
              border: "none",
              padding: 0,
              background: autoRebaseDraft ? COLORS.accent : COLORS.border,
              cursor: "pointer",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                left: autoRebaseDraft ? 25 : 3,
                width: 20,
                height: 20,
                background: autoRebaseDraft ? COLORS.pageBg : COLORS.textMuted,
                transition: "left 150ms ease",
              }}
            />
          </button>
        </div>

        <div
          style={{
            marginBottom: 16,
            display: "inline-flex",
            alignItems: "center",
            padding: "4px 8px",
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: autoRebaseDraft ? COLORS.success : COLORS.textMuted,
            background: autoRebaseDraft ? `${COLORS.success}18` : `${COLORS.textDim}18`,
            border: autoRebaseDraft ? `1px solid ${COLORS.success}30` : `1px solid ${COLORS.textDim}30`,
          }}
        >
          {autoRebaseDraft ? "Enabled" : "Disabled"}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" style={primaryButton()} disabled={busy} onClick={() => void saveAutoRebaseSettings()}>
            {busy ? "Saving..." : "Save lane behavior"}
          </button>
        </div>
      </div>
    </section>
  );
}
