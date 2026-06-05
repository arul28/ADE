import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowSquareOut,
  CheckCircle,
  Clock,
  Copy,
  Check,
  GithubLogo,
  GitPullRequest,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { PrSummary } from "../../../shared/types";
import { formatPrBadgeLabel } from "../prs/shared/prFormatters";
import { ChatPrInlineCreator } from "./ChatPrInlineCreator";

/**
 * Left floating info-pane for an ADE chat's pull request. Mirrors the right
 * Chat-actions pane: when a PR exists we show its live status + quick actions;
 * when none exists we embed a compact inline PR creator (ChatPrInlineCreator)
 * so the user never leaves the Work tab. CLI sessions keep the inline pill menu
 * — this pane is only wired when AgentChatPane passes the toggle.
 */

const paneAction =
  "inline-flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-left text-[12px] font-medium text-fg/65 transition-colors hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-fg/85";

function stateTone(state: PrSummary["state"]): { dot: string; label: string } {
  switch (state) {
    case "open": return { dot: "bg-emerald-400", label: "Open" };
    case "draft": return { dot: "bg-amber-400/70", label: "Draft" };
    case "merged": return { dot: "bg-violet-400", label: "Merged" };
    case "closed": return { dot: "bg-red-400/70", label: "Closed" };
    default: return { dot: "bg-fg/25", label: String(state) };
  }
}

function ChecksLabel({ status }: { status: PrSummary["checksStatus"] }) {
  switch (status) {
    case "passing":
      return <span className="inline-flex items-center gap-1 text-emerald-300/80"><CheckCircle size={11} weight="fill" />Checks passing</span>;
    case "failing":
      return <span className="inline-flex items-center gap-1 text-red-300/85"><XCircle size={11} weight="fill" />Checks failing</span>;
    case "pending":
      return <span className="inline-flex items-center gap-1 text-amber-300/80"><Clock size={11} weight="fill" />Checks running</span>;
    default:
      return null;
  }
}

function PrDetails({
  pr,
  copied,
  onOpenAde,
  onOpenGitHub,
  onCopy,
}: {
  pr: PrSummary;
  copied: boolean;
  onOpenAde: () => void;
  onOpenGitHub: () => void;
  onCopy: () => void;
}) {
  const tone = stateTone(pr.state);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={cn("inline-block h-2 w-2 rounded-full", tone.dot)} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg/55">{tone.label}</span>
        <span className="ml-auto font-mono text-[11px] text-fg/45">{formatPrBadgeLabel(pr)}</span>
      </div>
      <h3 className="text-[14px] font-semibold leading-snug text-fg/90">{pr.title}</h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg/50">
        <ChecksLabel status={pr.checksStatus} />
        {pr.additions > 0 || pr.deletions > 0 ? (
          <span className="inline-flex items-center gap-1">
            <span className="text-emerald-400/60">+{pr.additions}</span>
            <span className="text-red-400/60">−{pr.deletions}</span>
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5 pt-1">
        <button type="button" onClick={onOpenAde} className={paneAction}>
          <GitPullRequest size={12} weight="bold" />
          Open in ADE
        </button>
        <button type="button" onClick={onOpenGitHub} className={paneAction}>
          <GithubLogo size={12} weight="bold" />
          Open on GitHub
          <ArrowSquareOut size={10} className="ml-auto opacity-60" />
        </button>
        <button type="button" onClick={onCopy} className={paneAction}>
          {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
          {copied ? "Copied link" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

export const ChatPrPane = React.memo(function ChatPrPane({
  laneId,
  branchName,
  chatModelId,
}: {
  laneId: string;
  branchName?: string | null;
  /** The active chat session's model — forwarded to the inline creator's AI draft. */
  chatModelId?: string | null;
  /** Retained for the caller's toggle wiring; the pane no longer renders its own close affordance (the header PR pill toggles it). */
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const [pr, setPr] = useState<PrSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPr(await window.ade.prs.getForLane(laneId));
    } catch {
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [laneId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type === "prs-updated") void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  const openInAde = useCallback(() => {
    if (!pr) return;
    navigate(`/prs?tab=normal&prId=${encodeURIComponent(pr.id)}`);
  }, [pr, navigate]);

  const openInGitHub = useCallback(async () => {
    if (!pr) return;
    try {
      await window.ade.prs.openInGitHub(pr.id);
    } catch {
      try { window.open(pr.githubUrl, "_blank", "noopener,noreferrer"); } catch { /* noop */ }
    }
  }, [pr]);

  const copyLink = useCallback(async () => {
    if (!pr) return;
    try {
      await navigator.clipboard.writeText(pr.githubUrl);
      setCopied(true);
    } catch {
      /* clipboard denied */
    }
  }, [pr]);

  return (
    <div className="flex h-full min-h-0 flex-col font-sans">
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {loading ? (
          <p className="px-1 py-6 text-center text-[12px] text-fg/40">Loading…</p>
        ) : pr ? (
          <PrDetails
            pr={pr}
            copied={copied}
            onOpenAde={openInAde}
            onOpenGitHub={() => void openInGitHub()}
            onCopy={() => void copyLink()}
          />
        ) : (
          <ChatPrInlineCreator laneId={laneId} branchName={branchName ?? null} chatModelId={chatModelId ?? null} />
        )}
      </div>
    </div>
  );
});

export default ChatPrPane;
