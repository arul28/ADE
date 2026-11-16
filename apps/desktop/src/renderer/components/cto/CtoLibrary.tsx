import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, GitBranch, GitPullRequest, Image, Tray, VideoCamera } from "@phosphor-icons/react";
import type { ComputerUseArtifactView, LaneSummary, OpenProjectBinding, PrSummary } from "../../../shared/types";
import { navigateToAppTarget } from "../../lib/openExternal";
import type { CtoChildChat } from "./useCtoActivityData";
import { artifactOwnerChatId, openCtoChat, openCtoPr } from "./ctoNavigation";
import { CtoEmptyLine } from "./ctoSettingsUi";

type LibraryFilter = "all" | "prs" | "proof" | "lanes";

const FILTERS: Array<{ id: LibraryFilter; label: string; empty: string }> = [
  { id: "all", label: "All", empty: "Nothing yet" },
  { id: "prs", label: "PRs", empty: "No PRs yet" },
  { id: "proof", label: "Proof", empty: "No proof yet" },
  { id: "lanes", label: "Lanes", empty: "No lanes yet" },
];

type LibraryItem = {
  key: string;
  kind: Exclude<LibraryFilter, "all">;
  title: string;
  detail: string;
  at: string;
  icon: React.ReactNode;
  open: () => void;
};

const PR_STATE_COLOR: Record<PrSummary["state"], string> = {
  open: "#3fb950",
  draft: "var(--kit-text-3)",
  merged: "#a371f7",
  closed: "#f85149",
};

const PR_STATE_WORD: Record<PrSummary["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

function artifactKindWord(kind: ComputerUseArtifactView["kind"]): string {
  switch (kind) {
    case "screenshot": return "Screenshot";
    case "video_recording": return "Recording";
    case "browser_trace": return "Browser trace";
    case "browser_verification": return "Browser check";
    case "console_logs": return "Console log";
    default: return "Proof";
  }
}

function ArtifactGlyph({ kind }: { kind: ComputerUseArtifactView["kind"] }) {
  if (kind === "screenshot") return <Image size={14} />;
  if (kind === "video_recording") return <VideoCamera size={14} />;
  return <FileText size={14} />;
}

function relativeDay(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * What the CTO's work produced: PRs its chats opened, proof filed by it or its
 * chats, and the lanes its chats worked in. Rows open the thing on the CTO's
 * machine.
 */
export function CtoLibrary({
  childChats,
  prs,
  proof,
  loaded,
  lanes,
  primaryLaneId,
  pin,
  pinTargetsTab,
}: {
  childChats: CtoChildChat[];
  prs: PrSummary[];
  proof: ComputerUseArtifactView[];
  loaded: boolean;
  lanes: LaneSummary[];
  primaryLaneId: string | null;
  pin: OpenProjectBinding | null;
  pinTargetsTab: boolean;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const lanesById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);

  const items = useMemo<LibraryItem[]>(() => {
    const out: LibraryItem[] = [];
    for (const pr of prs) {
      out.push({
        key: `pr:${pr.id}`,
        kind: "prs",
        title: pr.title || `PR #${pr.githubPrNumber}`,
        detail: `${PR_STATE_WORD[pr.state]} · #${pr.githubPrNumber}${lanesById.get(pr.laneId)?.name ? ` · ${lanesById.get(pr.laneId)!.name}` : ""}`,
        at: pr.updatedAt,
        icon: <GitPullRequest size={14} weight="bold" style={{ color: PR_STATE_COLOR[pr.state] }} />,
        open: () => openCtoPr(pr, pinTargetsTab),
      });
    }
    const chatTitles = new Map(childChats.map((child) => [child.summary.sessionId, child.summary]));
    for (const artifact of proof) {
      const ownerId = artifactOwnerChatId(artifact);
      const owner = ownerId ? chatTitles.get(ownerId) : null;
      out.push({
        key: `proof:${artifact.id}`,
        kind: "proof",
        title: artifact.title || artifactKindWord(artifact.kind),
        detail: `${artifactKindWord(artifact.kind)}${owner?.title ? ` · ${owner.title}` : ""}`,
        at: artifact.createdAt,
        icon: <ArtifactGlyph kind={artifact.kind} />,
        open: () => {
          // The artifact view opens on the tab's machine; proof on another
          // machine opens from the chat that filed it, which runs there.
          if (pinTargetsTab) navigateToAppTarget({ kind: "artifact", artifactId: artifact.id });
          else if (owner) openCtoChat(navigate, owner.sessionId, owner.laneId, pin, false);
        },
      });
    }
    const byLane = new Map<string, CtoChildChat[]>();
    for (const child of childChats) {
      const laneId = child.summary.laneId;
      if (!laneId || laneId === primaryLaneId) continue;
      const list = byLane.get(laneId) ?? [];
      list.push(child);
      byLane.set(laneId, list);
    }
    for (const [laneId, chats] of byLane) {
      const lane = lanesById.get(laneId);
      const newest = chats[0]!;
      out.push({
        key: `lane:${laneId}`,
        kind: "lanes",
        title: lane?.name ?? newest.summary.title ?? "Lane",
        detail: `${chats.length} ${chats.length === 1 ? "chat" : "chats"}${lane?.branchRef ? ` · ${lane.branchRef.replace(/^refs\/heads\//, "")}` : ""}`,
        at: newest.summary.lastActivityAt ?? newest.summary.startedAt,
        icon: <GitBranch size={14} />,
        open: () => {
          if (pinTargetsTab) navigateToAppTarget({ kind: "lane", laneId });
          else openCtoChat(navigate, newest.summary.sessionId, laneId, pin, false);
        },
      });
    }
    out.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
    return out;
  }, [childChats, lanesById, navigate, pin, pinTargetsTab, primaryLaneId, proof, prs]);

  const shown = filter === "all" ? items : items.filter((item) => item.kind === filter);
  const counts: Record<LibraryFilter, number> = {
    all: items.length,
    prs: items.filter((item) => item.kind === "prs").length,
    proof: items.filter((item) => item.kind === "proof").length,
    lanes: items.filter((item) => item.kind === "lanes").length,
  };

  return (
    <div className="ade-cto-library" data-testid="cto-library">
      <div className="ade-cto-filters" role="group" aria-label="Show">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="ade-cto-filter"
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
            {counts[entry.id] > 0 ? <span className="ade-cto-filter-count">{counts[entry.id]}</span> : null}
          </button>
        ))}
      </div>
      {!loaded ? (
        <CtoEmptyLine icon={<Tray size={14} />}>Loading…</CtoEmptyLine>
      ) : shown.length === 0 ? (
        <CtoEmptyLine icon={<Tray size={14} />} hint="PRs, proof and lanes from the chats it starts">
          {FILTERS.find((entry) => entry.id === filter)?.empty ?? "Nothing yet"}
        </CtoEmptyLine>
      ) : (
        <ul className="ade-cto-list">
          {shown.map((item) => (
            <li key={item.key}>
              <button type="button" className="ade-cto-row" onClick={item.open} title={`${item.title}
${item.detail}`}>
                <span className="ade-cto-row-icon">{item.icon}</span>
                <span className="ade-cto-row-body">
                  <span className="ade-cto-row-title">{item.title}</span>
                  <span className="ade-cto-row-detail">{item.detail}</span>
                </span>
                <span className="ade-cto-row-meta">{relativeDay(item.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
