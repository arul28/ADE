import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown as ChevronDown,
  ChatCircleDots as MessageSquarePlus,
  GearSix,
  Terminal,
  Brain as BrainCircuit,
} from "@phosphor-icons/react";
import type { TerminalLaunchProfile, TerminalProfilesSnapshot, TerminalToolType } from "../../../shared/types";
import { ToolLogo } from "./ToolLogos";
import { TerminalSettingsDialog, readLaunchTracked, persistLaunchTracked } from "./TerminalSettingsDialog";
import { COLORS, MONO_FONT, LABEL_STYLE, inlineBadge } from "../lanes/laneDesignTokens";

const DEFAULT_PROFILE_IDS = ["claude", "codex", "shell"] as const;

function toolTypeFromProfileId(profileId: string): TerminalToolType | null {
  const id = profileId.trim().toLowerCase();
  if (id === "claude") return "claude";
  if (id === "codex") return "codex";
  if (id === "shell") return "shell";
  if (id === "aider") return "aider";
  if (id === "cursor") return "cursor";
  if (id === "continue") return "continue";
  return "other";
}

export function LaunchPanel({
  lanes,
  onLaunchPty,
  onLaunchChat,
}: {
  lanes: { id: string; name: string }[];
  onLaunchPty: (laneId: string, profile: "claude" | "codex" | "shell") => void;
  onLaunchChat: (laneId: string, provider: "claude" | "codex") => void;
}) {
  const [laneId, setLaneId] = useState<string>(lanes[0]?.id ?? "");
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfilesSnapshot | null>(null);
  const [launchTracked, setLaunchTracked] = useState(readLaunchTracked());
  const chatDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!laneId && lanes.length > 0) setLaneId(lanes[0]!.id);
  }, [lanes, laneId]);

  /* Close chat dropdown on outside click */
  useEffect(() => {
    if (!chatOpen) return;
    const handler = (e: MouseEvent) => {
      if (chatDropdownRef.current && !chatDropdownRef.current.contains(e.target as Node)) {
        setChatOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [chatOpen]);

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
          fontFamily: MONO_FONT,
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
                fontFamily: MONO_FONT,
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
            onClick={() => onLaunchPty(laneId, "claude")}
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
            onClick={() => onLaunchPty(laneId, "codex")}
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
            onClick={() => onLaunchPty(laneId, "shell")}
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
          <div ref={chatDropdownRef} style={{ position: 'relative' }}>
            <button
              type="button"
              disabled={!laneId}
              onClick={() => setChatOpen((v) => !v)}
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
              <ChevronDown
                size={10}
                weight="regular"
                style={{
                  opacity: 0.6,
                  transition: 'transform 150ms',
                  transform: chatOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </button>
            {chatOpen && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: '100%',
                  zIndex: 50,
                  marginTop: 4,
                  width: 160,
                  background: COLORS.recessedBg,
                  border: '1px solid ' + COLORS.border,
                  borderRadius: 0,
                  padding: '2px 0',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                }}
              >
                <button
                  type="button"
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 12px',
                    textAlign: 'left',
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    fontWeight: 600,
                    color: COLORS.textSecondary,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    letterSpacing: '0.5px',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  onClick={() => { onLaunchChat(laneId, "claude"); setChatOpen(false); }}
                >
                  <BrainCircuit size={14} weight="regular" style={{ color: '#F97316' }} />
                  CLAUDE
                </button>
                <button
                  type="button"
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 12px',
                    textAlign: 'left',
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    fontWeight: 600,
                    color: COLORS.textSecondary,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    letterSpacing: '0.5px',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  onClick={() => { onLaunchChat(laneId, "codex"); setChatOpen(false); }}
                >
                  <BrainCircuit size={14} weight="regular" style={{ color: '#3B82F6' }} />
                  CODEX
                </button>
              </div>
            )}
          </div>

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
