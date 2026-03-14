import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CaretDown as ChevronDown,
  ChatCircleDots as MessageSquarePlus,
  GearSix,
  Terminal,
} from "@phosphor-icons/react";
import type { TerminalLaunchProfile, TerminalProfilesSnapshot } from "../../../shared/types";
import { DEFAULT_PROFILE_IDS, toolTypeFromProfileId } from "../../lib/sessions";
import { ToolLogo } from "./ToolLogos";
import { TerminalSettingsDialog, readLaunchTracked, persistLaunchTracked } from "./TerminalSettingsDialog";
import { COLORS, SANS_FONT, LABEL_STYLE, inlineBadge } from "../lanes/laneDesignTokens";

export function LaunchPanel({
  lanes,
  onLaunchPty,
  onLaunchChat,
}: {
  lanes: { id: string; name: string }[];
  onLaunchPty: (laneId: string, profile: "claude" | "codex" | "shell", tracked?: boolean) => void;
  onLaunchChat: (laneId: string) => void;
}) {
  const [laneId, setLaneId] = useState<string>(lanes[0]?.id ?? "");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfilesSnapshot | null>(null);
  const [launchTracked, setLaunchTracked] = useState(readLaunchTracked());

  useEffect(() => {
    if (!laneId && lanes.length > 0) setLaneId(lanes[0]!.id);
  }, [lanes, laneId]);

  useEffect(() => {
    let cancelled = false;
    window.ade.terminalProfiles
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        setTerminalProfiles(snapshot);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const customProfiles = useMemo(() => {
    if (!terminalProfiles) return [];
    return terminalProfiles.profiles.filter(
      (p) => !(DEFAULT_PROFILE_IDS as readonly string[]).includes(p.id),
    );
  }, [terminalProfiles]);

  const launchCustomProfile = useCallback(
    (profile: TerminalLaunchProfile) => {
      if (!laneId) return;
      const toolType = toolTypeFromProfileId(profile.id);
      const command = (profile.command ?? "").trim();
      window.ade.pty
        .create({
          laneId,
          cols: 100,
          rows: 30,
          title: profile.name || "Shell",
          tracked: launchTracked,
          toolType,
          startupCommand: command || undefined,
        })
        .catch(() => {});
    },
    [laneId, launchTracked],
  );

  return (
    <>
      <div
        style={{
          background: COLORS.recessedBg,
          borderBottom: '1px solid ' + COLORS.border,
          borderLeft: '2px solid #A78BFA30',
          padding: '12px 16px',
          fontFamily: SANS_FONT,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Lane selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={LABEL_STYLE}>LANE</label>
          <div style={{ position: 'relative', flex: 1 }}>
            <select
              style={{
                height: 24,
                width: '100%',
                appearance: 'none' as const,
                background: COLORS.recessedBg,
                border: '1px solid ' + COLORS.outlineBorder,
                borderRadius: 0,
                fontFamily: SANS_FONT,
                fontSize: 12,
                color: COLORS.textPrimary,
                paddingLeft: 8,
                paddingRight: 24,
                outline: 'none',
                cursor: 'pointer',
              }}
              value={laneId}
              onChange={(e) => setLaneId(e.target.value)}
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <ChevronDown
              size={12}
              weight="regular"
              style={{
                pointerEvents: 'none',
                position: 'absolute',
                right: 6,
                top: '50%',
                transform: 'translateY(-50%)',
                color: COLORS.textMuted,
              }}
            />
          </div>
          <button
            type="button"
            title="Terminal settings"
            onClick={() => setSettingsOpen(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              padding: 0,
              background: 'transparent',
              border: '1px solid ' + COLORS.outlineBorder,
              borderRadius: 0,
              color: COLORS.textMuted,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <GearSix size={14} />
          </button>
        </div>

        {/* Quick-launch row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            disabled={!laneId}
            onClick={() => onLaunchPty(laneId, "claude", launchTracked)}
            style={{
              ...inlineBadge('#F97316'),
              cursor: 'pointer',
              gap: 5,
              opacity: !laneId ? 0.4 : 1,
            }}
            onMouseEnter={(e) => { if (laneId) (e.currentTarget.style.opacity = '0.8'); }}
            onMouseLeave={(e) => { if (laneId) (e.currentTarget.style.opacity = '1'); }}
          >
            <ToolLogo toolType="claude" size={12} />
            CLAUDE
          </button>
          <button
            type="button"
            disabled={!laneId}
            onClick={() => onLaunchPty(laneId, "codex", launchTracked)}
            style={{
              ...inlineBadge('#3B82F6'),
              cursor: 'pointer',
              gap: 5,
              opacity: !laneId ? 0.4 : 1,
            }}
            onMouseEnter={(e) => { if (laneId) (e.currentTarget.style.opacity = '0.8'); }}
            onMouseLeave={(e) => { if (laneId) (e.currentTarget.style.opacity = '1'); }}
          >
            <ToolLogo toolType="codex" size={12} />
            CODEX
          </button>
          <button
            type="button"
            disabled={!laneId}
            onClick={() => onLaunchPty(laneId, "shell", launchTracked)}
            style={{
              ...inlineBadge('#22C55E'),
              cursor: 'pointer',
              gap: 5,
              opacity: !laneId ? 0.4 : 1,
            }}
            onMouseEnter={(e) => { if (laneId) (e.currentTarget.style.opacity = '0.8'); }}
            onMouseLeave={(e) => { if (laneId) (e.currentTarget.style.opacity = '1'); }}
          >
            <ToolLogo toolType="shell" size={12} />
            SHELL
          </button>

          {/* Custom profile buttons */}
          {customProfiles.map((p) => {
            const badgeColor = p.color || COLORS.textMuted;
            return (
              <button
                key={p.id}
                type="button"
                disabled={!laneId}
                onClick={() => launchCustomProfile(p)}
                style={{
                  ...inlineBadge(badgeColor),
                  cursor: 'pointer',
                  gap: 5,
                  opacity: !laneId ? 0.4 : 1,
                }}
                onMouseEnter={(e) => { if (laneId) (e.currentTarget.style.opacity = '0.8'); }}
                onMouseLeave={(e) => { if (laneId) (e.currentTarget.style.opacity = '1'); }}
                title={p.command ? `${p.name} (${p.command})` : p.name}
              >
                <Terminal size={12} weight="regular" />
                {(p.name || '').toUpperCase()}
              </button>
            );
          })}

          {/* Divider */}
          <div
            style={{
              width: 1,
              height: 20,
              background: COLORS.border,
              margin: '0 2px',
              flexShrink: 0,
            }}
          />

          {/* Chat launch */}
          <button
            type="button"
            disabled={!laneId}
            onClick={() => onLaunchChat(laneId)}
            style={{
              ...inlineBadge(COLORS.accent),
              cursor: 'pointer',
              gap: 5,
              opacity: !laneId ? 0.4 : 1,
            }}
            onMouseEnter={(e) => { if (laneId) (e.currentTarget.style.opacity = '0.8'); }}
            onMouseLeave={(e) => { if (laneId) (e.currentTarget.style.opacity = '1'); }}
          >
            <MessageSquarePlus size={12} weight="regular" />
            CHAT
          </button>

          {/* Tracked toggle */}
          <button
            type="button"
            onClick={() => {
              const next = !launchTracked;
              setLaunchTracked(next);
              persistLaunchTracked(next);
            }}
            style={{
              ...(launchTracked
                ? inlineBadge(COLORS.success)
                : { ...inlineBadge(COLORS.textDim), cursor: 'pointer' }),
              cursor: 'pointer',
            }}
            title={launchTracked ? "Tracked: context collected" : "Untracked: no context"}
          >
            {launchTracked ? "TRACKED" : "UNTRACKED"}
          </button>
        </div>
      </div>

      <TerminalSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        terminalProfiles={terminalProfiles}
        onProfilesSaved={setTerminalProfiles}
        launchTracked={launchTracked}
        onLaunchTrackedChange={(v) => { setLaunchTracked(v); persistLaunchTracked(v); }}
      />
    </>
  );
}
