import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../state/appStore";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";

type Hint = {
  id: string;
  title?: string;
  body: string;
  docUrl?: string;
};

const SESSION_KEY = "ade.didYouKnow.shown";

const DEFAULT_HINTS: Hint[] = [
  {
    id: "lanes-parallel",
    body: "Each lane is its own worktree, so parallel agents can change files without trampling each other.",
    docUrl: docs.lanesOverview,
  },
  {
    id: "lane-runtime-isolation",
    body: "Lane-scoped ports, proxy routes, OAuth callbacks, terminals, and health checks keep dev environments separated.",
    docUrl: docs.lanesEnvironment,
  },
  {
    id: "lane-stacks",
    body: "Stacked lanes know their parent chain, so ADE can surface rebase order and PR queue context instead of leaving it in your head.",
    docUrl: docs.lanesStacks,
  },
  {
    id: "work-sessions",
    body: "The Work tab keeps chats, CLI agents, and shells as resumable sessions tied to their lane.",
    docUrl: docs.chatOverview,
  },
  {
    id: "chat-context",
    body: "Chat context can include files, Linear issues, simulator selections, browser observations, and proof artifacts when those tools are active.",
    docUrl: docs.chatContext,
  },
  {
    id: "proof-intentional",
    body: "Proof is intentional: capture or attach the reviewer-visible screenshot, video, or trace you want to keep.",
    docUrl: docs.proof,
  },
  {
    id: "proof-ownership",
    body: "One proof artifact can be linked to a chat, lane, PR, or Linear issue without losing provenance.",
    docUrl: docs.proof,
  },
  {
    id: "prs-ade-links",
    body: "ADE PR creation returns both the GitHub URL and an ADE deep link, so handoffs can reopen the exact PR context.",
    docUrl: docs.prsOverview,
  },
  {
    id: "prs-stacks",
    body: "The PRs tab shows native GitHub stacks alongside ADE integration proposals and rebase needs.",
    docUrl: docs.prsOverview,
  },
  {
    id: "graph-projection",
    body: "The workspace graph is not a separate data layer; it projects lane, PR, sync, conflict, and activity state into one canvas.",
    docUrl: docs.workspaceGraph,
  },
  {
    id: "graph-risk",
    body: "Graph risk mode turns pairwise file overlap into clickable conflict edges before a merge gets painful.",
    docUrl: docs.workspaceGraph,
  },
  {
    id: "ios-simulator-owner",
    body: "The iOS Simulator drawer is owned by the active runtime and chat/lane, so control and proof stay attached to the right work.",
    docUrl: docs.iosSimulator,
  },
  {
    id: "simulator-preview",
    body: "Preview Lab can resolve a selected simulator element back to SwiftUI preview targets when source context is available.",
    docUrl: docs.iosSimulator,
  },
  {
    id: "sync-local-first",
    body: "ADE sync is local-first and peer-to-peer: runtime state converges over WebSocket without a cloud dependency.",
    docUrl: docs.syncMultiDevice,
  },
  {
    id: "remote-runtime",
    body: "When a window is bound to a remote runtime, lanes, PR actions, proof storage, and simulator checks run on that remote machine.",
    docUrl: docs.syncMultiDevice,
  },
  {
    id: "deeplinks",
    body: "ADE links can target a lane, Work session, branch, PR, or Linear issue from desktop, iOS, ADE Code, or the web handoff page.",
    docUrl: docs.deeplinks,
  },
  {
    id: "cto-identity",
    body: "The CTO is a persistent project identity with continuity, workers, Linear dispatch, and an operator-only tool surface.",
    docUrl: docs.ctoOverview,
  },
  {
    id: "workers",
    body: "Workers are named project agents with roles, budgets, adapter settings, and optional Linear identities.",
    docUrl: docs.ctoWorkers,
  },
  {
    id: "automations-guardrails",
    body: "Automations dispatch real ADE work, so they rely on explicit triggers, guardrails, and the agent's own proof captures.",
    docUrl: docs.automationsGuardrails,
  },
  {
    id: "settings-scope",
    body: "Shared project settings live in `.ade/ade.yaml`; local machine-only overrides live in `.ade/local.yaml`.",
    docUrl: docs.settingsGeneral,
  },
  {
    id: "help-chip",
    body: "The small \"?\" next to a word opens a quick plain-English definition without interrupting your flow.",
    docUrl: docs.keyConcepts,
  },
];

type DidYouKnowProps = {
  hints?: Hint[];
};

export function DidYouKnow({ hints }: DidYouKnowProps) {
  const didYouKnowEnabled = useAppStore((s) => s.didYouKnowEnabled);
  const [dismissed, setDismissed] = useState(false);
  const [hint, setHint] = useState<Hint | null>(null);

  useEffect(() => {
    if (!didYouKnowEnabled) return;
    try {
      if (sessionStorage.getItem(SESSION_KEY) === "1") return;
    } catch {
      // sessionStorage unavailable — fall through and show anyway.
    }
    const pool = hints && hints.length > 0 ? hints : DEFAULT_HINTS;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setHint(pick ?? null);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
  }, [didYouKnowEnabled, hints]);

  if (!didYouKnowEnabled) return null;
  if (!hint || dismissed) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="ade-didyouknow"
      style={{
        position: "fixed",
        bottom: 18,
        right: 18,
        zIndex: 9996,
        maxWidth: 340,
        background: "var(--color-popup-bg, #151325)",
        color: "var(--color-fg, #F0F0F2)",
        border: "1px solid rgba(255, 255, 255, 0.10)",
        borderRadius: 10,
        padding: "12px 14px",
        boxShadow: "0 12px 30px -8px rgba(0, 0, 0, 0.6)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            margin: 0,
            color: "var(--color-muted-fg, #B7B6C3)",
          }}
        >
          <div
            style={{
              marginBottom: 3,
              color: "var(--color-fg, #F0F0F2)",
              fontWeight: 700,
            }}
          >
            {hint.title ?? "Did you know?"}
          </div>
          <div>{hint.body}</div>
        </div>
        <button
          type="button"
          aria-label="Dismiss hint"
          onClick={() => setDismissed(true)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--color-muted-fg, #908FA0)",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            padding: 2,
          }}
        >
          ×
        </button>
      </div>
      {hint.docUrl ? (
        <a
          href={hint.docUrl}
          onClick={(e) => {
            e.preventDefault();
            openExternalUrl(hint.docUrl);
          }}
          className="ade-stt-doc"
          style={{ display: "inline-block", marginTop: 6 }}
        >
          Learn more →
        </a>
      ) : null}
    </div>,
    document.body,
  );
}
