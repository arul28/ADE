import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { COLORS, MONO_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function LaneBehaviorSection() {
  const navigate = useNavigate();
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
      setNotice("Auto-rebase settings saved.");
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
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6, maxWidth: 760 }}>
              When enabled, ADE can auto-rebase and auto-push clean child lanes as their parent advances. If a lane cannot be rebased cleanly, ADE stops, restores the lane, and surfaces a warning banner that links to the Rebase tab for AI or manual follow-up.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (busy) return;
              setAutoRebaseDraft((current) => !current);
            }}
            disabled={busy}
            style={{
              position: "relative",
              width: 48,
              height: 26,
              border: "none",
              padding: 0,
              background: autoRebaseDraft ? COLORS.accent : COLORS.border,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.65 : 1,
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
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 8,
          }}
        >
          {[
            {
              label: "Auto-rebase",
              detail: autoRebaseDraft ? "Rebases and pushes clean child lanes automatically" : "Disabled until you switch it on",
              active: autoRebaseDraft,
            },
            {
              label: "Conflict handling",
              detail: "Stops, restores the lane, and shows the warning banner",
              active: autoRebaseDraft,
            },
            {
              label: "Follow-up",
              detail: "Open the Rebase tab for AI or manual retry",
              active: autoRebaseDraft,
            },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                padding: "8px 10px",
                border: item.active ? `1px solid ${COLORS.accent}24` : `1px solid ${COLORS.border}`,
                background: item.active ? `${COLORS.accent}08` : COLORS.recessedBg,
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "0.8px", color: item.active ? COLORS.textPrimary : COLORS.textMuted }}>
                {item.label}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.45 }}>
                {item.detail}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={{
              ...primaryButton(),
              minWidth: 180,
            }}
            disabled={busy}
            onClick={() => void saveAutoRebaseSettings()}
          >
            {busy ? "Saving..." : "Save auto-rebase"}
          </button>
          <button
            type="button"
            style={{
              ...outlineButton({ height: 32 }),
              minWidth: 180,
            }}
            disabled={busy}
            onClick={() => navigate("/prs?tab=rebase")}
          >
            Open Rebase tab
          </button>
        </div>
      </div>
    </section>
  );
}
