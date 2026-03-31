import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton, recessedStyle } from "../lanes/laneDesignTokens";
import type { LaneCleanupConfig } from "../../../shared/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const inputStyle: CSSProperties = {
  height: 36,
  width: "100%",
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  padding: "0 12px",
  fontSize: 12,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  borderRadius: 8,
  outline: "none",
  transition: "border-color 150ms ease",
};

const miniLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  fontFamily: SANS_FONT,
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  color: COLORS.textMuted,
  marginBottom: 6,
};

export function LaneBehaviorSection() {
  const navigate = useNavigate();
  const [autoRebaseDraft, setAutoRebaseDraft] = useState(false);
  const [cleanup, setCleanup] = useState<LaneCleanupConfig>({});
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

    const effectiveCleanup = snapshot.effective.laneCleanup ?? {};
    const localCleanup = snapshot.local.laneCleanup ?? {};
    setCleanup({ ...effectiveCleanup, ...localCleanup });
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
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          git: {
            ...currentGit,
            autoRebaseOnHeadChange: autoRebaseDraft,
          },
          laneCleanup: cleanup,
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

  const cleanupActive = !!(cleanup.maxActiveLanes || cleanup.autoArchiveAfterHours);

  return (
    <section style={{ padding: 16 }}>
      <div style={{ ...LABEL_STYLE, fontSize: 11, marginBottom: 8 }}>LANE BEHAVIOR</div>
      <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 16 }}>
        Auto-rebase, cleanup limits, and lane lifecycle.
      </div>

      {notice ? <div style={{ ...messageStyle(COLORS.success), marginBottom: 12 }}>{notice}</div> : null}
      {error ? <div style={{ ...messageStyle(COLORS.danger), marginBottom: 12 }}>{error}</div> : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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

        {/* Cleanup & limits */}
        <div style={cardStyle({ borderRadius: 12 })}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>Cleanup & limits</div>
            <div style={{ marginTop: 4, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
              Prevent lane sprawl by automatically archiving or removing inactive lanes.
            </div>
          </div>

          {/* Primary controls: max lanes + auto-archive. These are the ones that matter most. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <div style={miniLabel}>Max active lanes</div>
              <input
                style={inputStyle}
                type="number"
                min={0}
                value={cleanup.maxActiveLanes ?? ""}
                onChange={(e) => setCleanup({ ...cleanup, maxActiveLanes: e.target.value ? Number(e.target.value) : undefined })}
                placeholder="Unlimited"
              />
              <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
                When exceeded, the oldest inactive lane is archived.
              </div>
            </div>

            <div>
              <div style={miniLabel}>Auto-archive after inactivity</div>
              <input
                style={inputStyle}
                type="number"
                min={0}
                value={cleanup.autoArchiveAfterHours ?? ""}
                onChange={(e) => setCleanup({ ...cleanup, autoArchiveAfterHours: e.target.value ? Number(e.target.value) : undefined })}
                placeholder="Never"
              />
              <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
                Hours of inactivity before a lane is auto-archived.
              </div>
            </div>
          </div>

          {/* Secondary controls — only relevant if cleanup is active */}
          {cleanupActive && (
            <div style={{
              ...recessedStyle({ padding: 12, borderRadius: 8 }),
              marginBottom: 12,
            }}>
              <div style={{ ...miniLabel, marginBottom: 10 }}>Additional cleanup options</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={{ ...miniLabel, fontSize: 9 }}>Check every (hours)</div>
                  <input
                    style={inputStyle}
                    type="number"
                    min={0}
                    value={cleanup.cleanupIntervalHours ?? ""}
                    onChange={(e) => setCleanup({ ...cleanup, cleanupIntervalHours: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="6"
                  />
                  <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
                    How often to scan for stale lanes.
                  </div>
                </div>
                <div>
                  <div style={{ ...miniLabel, fontSize: 9 }}>Delete archived after (hours)</div>
                  <input
                    style={inputStyle}
                    type="number"
                    min={0}
                    value={cleanup.autoDeleteArchivedAfterHours ?? ""}
                    onChange={(e) => setCleanup({ ...cleanup, autoDeleteArchivedAfterHours: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="Never"
                  />
                  <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
                    Permanently remove archived lanes after this period.
                  </div>
                </div>
              </div>
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.borderMuted}`,
                borderRadius: 8,
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: COLORS.textPrimary }}>Delete remote branch on cleanup</div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 2 }}>
                    Also remove the remote branch when a lane is auto-deleted.
                  </div>
                </div>
                <ToggleSwitch
                  checked={cleanup.deleteRemoteBranchOnCleanup ?? false}
                  onChange={(v) => setCleanup({ ...cleanup, deleteRemoteBranchOnCleanup: v })}
                />
              </div>
            </div>
          )}
        </div>

        {/* Save + Open Rebase tab */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            style={outlineButton({ height: 32 })}
            disabled={busy}
            onClick={() => navigate("/prs?tab=rebase")}
          >
            Open Rebase tab
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
