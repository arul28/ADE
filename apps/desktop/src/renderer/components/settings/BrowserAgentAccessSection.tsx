import { useState } from "react";
import { ChatCircle, Check, GitBranch, UsersThree, type Icon } from "@phosphor-icons/react";
import type { BuiltInBrowserAgentAccessMode } from "../../../shared/types/builtInBrowser";
import {
  BROWSER_AGENT_ACCESS_MODES,
  BROWSER_AGENT_ACCESS_MODE_COPY,
  BROWSER_AGENT_ACCESS_TITLE,
  browserAgentAccessActions,
  projectNameFromRoot,
  shortAgentId,
  useBrowserAgentAccess,
} from "../chat/browser/browserAgentAccess";
import { ModernSection } from "./primitives";
import "./machineSettings.css";

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
    <ModernSection
      group="ADE browser"
      anchor="browser-agent-access"
      title={BROWSER_AGENT_ACCESS_TITLE}
      hint="The ADE browser keeps one signed-in profile for this computer. An agent that uses it can act as you on any site you are logged in to."
    >
      <div role="radiogroup" aria-label={BROWSER_AGENT_ACCESS_TITLE} className="ade-ap-grid3">
        {BROWSER_AGENT_ACCESS_MODES.map((value: BuiltInBrowserAgentAccessMode) => {
          const selected = mode === value;
          const copy = BROWSER_AGENT_ACCESS_MODE_COPY[value];
          const ModeIcon = MODE_ICON[value];
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy || !snapshot}
              onClick={() => void act(() => browserAgentAccessActions.setMode(value))}
              className="ade-ap-choice"
              data-active={selected}
            >
              <span className="ade-modern-choice-body">
                <span className="ade-modern-choice-title">
                  <ModeIcon size={14} />
                  <span style={{ minWidth: 0 }}>{copy.label}</span>
                  {selected ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                </span>
                <span className="ade-modern-choice-hint">{copy.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {grants.length > 0 ? (
        <div className="ade-modern-rows">
          <div className="ade-ms-grant" style={{ paddingTop: 10, paddingBottom: 10 }}>
            <span className="kit-eyebrow" style={{ flex: "none" }}>Allowed</span>
            <span className="ade-modern-muted" style={{ flex: 1, minWidth: 0 }}>
              {mode === "all" ? "Not needed while all agents can use it." : null}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => browserAgentAccessActions.revoke({ kind: "all" }))}
              className="ade-modern-btn"
              data-size="sm"
              data-variant="ghost"
            >
              Remove all
            </button>
          </div>
          {grants.map((grant) => (
            <div key={grant.key} className="ade-ms-grant">
              <span className="kit-tag" style={{ flex: "none" }}>{grant.kind}</span>
              <span
                className="ade-ms-grant-name"
                title={grant.detail ? `${grant.name} · ${grant.detail}` : grant.name}
              >
                {grant.name}
                {grant.detail ? <span>{` · ${grant.detail}`}</span> : null}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${grant.kind.toLowerCase()} ${grant.name}`}
                onClick={() => void act(grant.revoke)}
                className="ade-modern-btn"
                data-size="sm"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p role="alert" className="ade-modern-error">{error}</p> : null}
    </ModernSection>
  );
}

const MODE_ICON: Record<BuiltInBrowserAgentAccessMode, Icon> = {
  all: UsersThree,
  lanes: GitBranch,
  chats: ChatCircle,
};
