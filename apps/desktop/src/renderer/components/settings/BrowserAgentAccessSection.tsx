import { useState } from "react";
import type { BuiltInBrowserAgentAccessMode } from "../../../shared/types/builtInBrowser";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import {
  BROWSER_AGENT_ACCESS_MODES,
  BROWSER_AGENT_ACCESS_MODE_COPY,
  BROWSER_AGENT_ACCESS_TITLE,
  browserAgentAccessActions,
  projectNameFromRoot,
  shortAgentId,
  useBrowserAgentAccess,
} from "../chat/browser/browserAgentAccess";
import { SettingsCard, SettingsGroup } from "./primitives";

/**
 * "Agents can use the ADE browser", mirrored from the browser's own ⋯ menu.
 *
 * Machine-wide (the desktop's global state): the browser's signed-in profile is
 * one per ADE install, so who may drive it is a fact about this machine. The
 * lanes and chats the user allowed are listed under the choice, each with its
 * own Remove.
 */
export function BrowserAgentAccessSection() {
  const snapshot = useBrowserAgentAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch {
      setError("ADE couldn't save that.");
    } finally {
      setBusy(false);
    }
  };

  const mode = snapshot?.mode ?? "all";
  const grants = snapshot
    ? [
        ...snapshot.laneGrants.map((grant) => ({
          key: `lane:${grant.projectRoot ?? ""}:${grant.laneId}`,
          kind: "Lane",
          name: grant.laneName ?? shortAgentId(grant.laneId),
          detail: projectNameFromRoot(grant.projectRoot),
          revoke: () => browserAgentAccessActions.revoke({
            kind: "lane",
            projectRoot: grant.projectRoot,
            laneId: grant.laneId,
          }),
        })),
        ...snapshot.chatGrants.map((grant) => ({
          key: `chat:${grant.chatSessionId}`,
          kind: "Chat",
          name: grant.chatTitle ?? shortAgentId(grant.chatSessionId),
          detail: grant.laneName ? `lane ${grant.laneName}` : null,
          revoke: () => browserAgentAccessActions.revoke({ kind: "chat", chatSessionId: grant.chatSessionId }),
        })),
      ]
    : [];

  return (
    <SettingsGroup title="ADE browser">
      <SettingsCard
        anchor="browser-agent-access"
        title={BROWSER_AGENT_ACCESS_TITLE}
        description="The ADE browser keeps one signed-in profile for this computer. An agent that uses it can act as you on any site you are logged in to."
        stacked
        control={
          <div style={{ display: "grid", gap: 10 }}>
            <div
              role="radiogroup"
              aria-label={BROWSER_AGENT_ACCESS_TITLE}
              style={{ display: "flex", flexDirection: "column", gap: 2 }}
            >
              {BROWSER_AGENT_ACCESS_MODES.map((value: BuiltInBrowserAgentAccessMode) => {
                const selected = mode === value;
                const copy = BROWSER_AGENT_ACCESS_MODE_COPY[value];
                const disabled = busy || !snapshot;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    onClick={() => void act(() => browserAgentAccessActions.setMode(value))}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "9px 8px",
                      border: "none",
                      borderRadius: 8,
                      background: selected
                        ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                        : "transparent",
                      cursor: disabled ? "not-allowed" : "pointer",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        marginTop: 2,
                        width: 13,
                        height: 13,
                        flexShrink: 0,
                        borderRadius: "50%",
                        border: `1px solid ${selected ? COLORS.accent : COLORS.outlineBorder}`,
                        background: selected ? COLORS.accent : "transparent",
                        boxShadow: selected ? "inset 0 0 0 2.5px var(--color-bg)" : undefined,
                      }}
                    />
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span
                        style={{
                          fontFamily: SANS_FONT,
                          fontSize: 13,
                          fontWeight: selected ? 600 : 500,
                          color: COLORS.textPrimary,
                        }}
                      >
                        {copy.label}
                      </span>
                      <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                        {copy.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {grants.length > 0 ? (
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      fontFamily: SANS_FONT,
                      fontSize: 11,
                      fontWeight: 600,
                      color: COLORS.textSecondary,
                    }}
                  >
                    Allowed lanes and chats
                  </span>
                  {mode === "all" ? (
                    <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                      Not needed while all agents can use it.
                    </span>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(() => browserAgentAccessActions.revoke({ kind: "all" }))}
                    style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 11 }), marginLeft: "auto" }}
                  >
                    Remove all
                  </button>
                </div>
                <div style={{ display: "grid", gap: 2 }}>
                  {grants.map((grant) => (
                    <div
                      key={grant.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                        padding: "5px 8px",
                        borderRadius: 6,
                        background: COLORS.recessedBg,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: SANS_FONT,
                          fontSize: 10.5,
                          color: COLORS.textMuted,
                          width: 30,
                          flexShrink: 0,
                        }}
                      >
                        {grant.kind}
                      </span>
                      <span
                        title={grant.detail ? `${grant.name} · ${grant.detail}` : grant.name}
                        style={{
                          fontFamily: SANS_FONT,
                          fontSize: 12,
                          color: COLORS.textPrimary,
                          minWidth: 0,
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {grant.name}
                        {grant.detail ? (
                          <span style={{ color: COLORS.textMuted }}>{` · ${grant.detail}`}</span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${grant.kind.toLowerCase()} ${grant.name}`}
                        onClick={() => void act(grant.revoke)}
                        style={outlineButton({ height: 22, padding: "0 8px", fontSize: 11 })}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {error ? (
              <div role="alert" style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.danger }}>
                {error}
              </div>
            ) : null}
          </div>
        }
      />
    </SettingsGroup>
  );
}
