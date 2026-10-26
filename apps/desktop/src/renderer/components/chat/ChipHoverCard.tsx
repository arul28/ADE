// Hover cards for transcript chips.
//
// A chip is a POINTER (see `shared/chips.ts`) — deliberately compact, so `#1237`
// tells you nothing about what PR that is without leaving the conversation.
// These cards answer the one question a pointer provokes, in place: what is
// this, and is it still open.
//
// Deliberate constraints:
//
//   - **Never steals focus.** The card is a `pointer-events-none` portal with
//     `role="tooltip"`, not a popover. Nothing inside it is focusable, so the
//     caret stays in the composer and a hover cannot swallow the next keystroke.
//     That is also why this does not use Radix `Popover`, which moves focus into
//     its content by design.
//   - **Placement is the repo's tested module.** `computeTooltipPosition` —
//     flip-before-shift, never over the trigger — the same one the pane and
//     smart tooltips use.
//   - **Degrades to nothing.** No lane, no session row, no PR record, no
//     network: the card simply does not appear. There is no error state for a
//     hover.
//   - **Reads, never fetches, except for PRs and Linear issues.** Lanes and
//     chats already live in app state. PRs go through `listPrsCoalesced`, the
//     same coalesced reader the composer's `#` suggestions use; Linear issues go
//     through the issue viewer's cache (`linearIssueStore`), so a hover after
//     the issue was opened costs nothing and a hover before it warms the tab.
//     Both only once the user has actually hovered.
//   - **The CHAT's machine, not the tab's.** A lane id is unique per machine,
//     not globally, so resolving one against the project tab's lane list can
//     match a DIFFERENT lane that happens to share the id — and then print its
//     name and branch. A chat pinned to a remote machine must read that
//     machine's lanes, sessions and PRs, which is what `useChatRuntimeScope()`
//     plus `useLanesForPin` / `useSessionsForPin` resolve. Nothing here
//     touches a global store read.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { Chip } from "../../../shared/chips";
import type {
  ComputerUseArtifactView,
  LaneSummary,
  OpenProjectBinding,
  PrState,
  TerminalSessionSummary,
} from "../../../shared/types";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { loadLinearIssue, peekLinearIssue } from "../issues/linearIssueStore";
import { loadGitHubIssue, peekGitHubIssue } from "../issues/githubIssueStore";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { issueRefFromUrl } from "../../../shared/issueRefs";
import { LinearStateIcon } from "../lanes/linearBrand";
import { MachineChipCardBody } from "./MachineChipCard";
import { relativeWhen } from "../../lib/format";
import { useLanesForPin, useSessionsForPin } from "../../state/crossMachineLanes";
import { computeTooltipPosition, type TooltipPlacement } from "../ui/tooltipPosition";
import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";
import { ContextMenuRows, type ContextMenuEntry } from "../ui/ContextMenu";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { useChipPreviewImage } from "./chipPreviewStore";
import { ExtraChipCardBody, type ExtraChipCardData } from "./chipCardBodies";
import { getAgentChatSlashCommandsCached } from "../../lib/agentChatSlashCommandsCache";
import { getModelById, resolveProviderGroupForModel } from "../../../shared/modelRegistry";
import { modelMentionPermissionLabel } from "../../../shared/modelMentions";
import { modelPermissionPresentation } from "../../lib/modelPermissionOptions";
import { fixedFrameOf, fixedRect, fixedViewport } from "../../lib/webZoom";
import type { ChatMentionSuggestion } from "../../../shared/types/chatMentions";
import { McpMentionCardBody } from "./McpMentionCardBody";
import { settingsEntryById, settingsEntryLabel, settingUnavailableReason } from "../settings/settingsManifest";
import { settingAgentAccess, settingIsProtected } from "../../../shared/settingsAgentAccess";

/** Everything a card may read, all of it belonging to the CHAT's machine. */
export type ChipCardSources = {
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  /** Pin for pin-aware preload calls. Null = the chat runs on the tab's binding. */
  pin: OpenProjectBinding | null;
  /**
   * The chat's project root. Only used to KEY the coalesced PR read: with no
   * pin, `projectKey` falls back to the literal `"active"`, which every project
   * shares, so a read still in flight when the user switches projects would be
   * joined by the new project and answered with the old one's rows.
   */
  rootPath: string | null;
  sessionId: string | null;
  laneId: string | null;
};

/** A chip's view of the chat machine: its lanes and sessions. */
export type ChipScopeSources = {
  lanes: LaneSummary[] | null;
  sessions: TerminalSessionSummary[] | null;
};

/**
 * The machine this CHAT runs on. `AgentChatMessageList` sits under
 * `ChatRuntimeScopeProvider`, exactly like `UserMessageIssueContext` next door,
 * so the scope is already the right answer here — no prop drilling and,
 * crucially, no global store read of the project tab's lanes.
 */
export function useChipScopeSources(): ChipScopeSources {
  const scope = useChatRuntimeScope();
  const lanes = useLanesForPin(scope.binding);
  const sessions = useSessionsForPin(scope.binding);
  return { lanes, sessions };
}

const EMPTY_LANES: LaneSummary[] = [];
const EMPTY_SESSIONS: TerminalSessionSummary[] = [];

/** Long enough that skimming a message never flashes cards; short enough to feel attached. */
const HOVER_DELAY_MS = 360;
/** Holding the pointer this long turns the facts card into the chip's menu. */
const MENU_DWELL_MS = 1000;
/** Time to cross from the chip onto its menu before it closes. */
const MENU_LEAVE_GRACE_MS = 220;
const GAP = 6;
const VIEWPORT_PAD = 10;

export type ChipCardData =
  | { kind: "pr"; number: number; title: string | null; state: PrState; repo: string | null }
  | { kind: "lane"; name: string; branch: string | null; archived: boolean }
  | { kind: "chat"; title: string; lastActivity: string | null; lane: string | null; model: string | null; state: string }
  | {
    kind: "linear";
    identifier: string;
    title: string;
    stateName?: string | null;
    stateType?: string | null;
    assigneeName?: string | null;
  }
  | {
    kind: "github-issue";
    reference: string;
    title: string;
    state: "open" | "closed";
    stateReason: string | null;
    assignees: string[];
  }
  | { kind: "link"; host: string; title: string | null; imageUrl: string }
  | { kind: "machine"; machineKey: string }
  | {
    kind: "mcp";
    name: string;
    state: NonNullable<ChatMentionSuggestion["mcp"]>["state"];
    transport: NonNullable<ChatMentionSuggestion["mcp"]>["transport"];
    toolNames: string[];
    toolCount?: number | null;
    lastError: string | null;
    lastErrorAt?: number | null;
  }
  | ExtraChipCardData;

type ChipCardTarget =
  | { kind: "pr"; number: number; owner: string | null; repo: string | null }
  | { kind: "commit"; sha: string; laneId: string | null }
  | { kind: "lane"; laneId: string }
  | { kind: "chat"; sessionId: string }
  | { kind: "machine"; machineKey: string }
  | { kind: "mcp"; name: string }
  | { kind: "linear"; identifier: string }
  | { kind: "link"; host: string }
  | { kind: "github-issue"; owner: string; repo: string; number: number }
  | { kind: "terminal"; sessionId: string }
  | { kind: "model"; modelId: string; effort: string | null; permission: string | null }
  | { kind: "permission"; provider: string; value: string }
  | { kind: "skill"; name: string }
  | { kind: "branch"; branch: string; repoOwner: string; repoName: string; prNumber?: number }
  | { kind: "artifact"; artifactId: string }
  | { kind: "setting"; entryId: string };

function githubPullTarget(url: string): ChipCardTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { kind: "pr", number: Number(match[3]), owner: match[1]!, repo: match[2]!.replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}

function githubCommitTarget(url: string): ChipCardTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase().replace(/^www\./i, "") !== "github.com") return null;
    const match = parsed.pathname.match(/^\/[^/]+\/[^/]+\/commit\/([0-9a-f]{7,40})(?:\/|$)/i);
    return match ? { kind: "commit", sha: match[1]!, laneId: null } : null;
  } catch {
    return null;
  }
}

/** What entity this chip points at, or null when no card kind covers it. */
export function chipCardTarget(chip: Chip): ChipCardTarget | null {
  const source = chip.source;
  switch (chip.kind) {
    case "pr":
      if (source.origin === "deeplink" && source.target.kind === "pr") {
        return {
          kind: "pr",
          number: source.target.prNumber,
          owner: source.target.repoOwner ?? null,
          repo: source.target.repoName ?? null,
        };
      }
      return source.origin === "url" ? githubPullTarget(source.url) : null;
    case "commit":
      if (source.origin === "deeplink" && source.target.kind === "commit") {
        return { kind: "commit", sha: source.target.sha, laneId: source.target.laneId ?? null };
      }
      return source.origin === "url" ? githubCommitTarget(source.url) : null;
    case "lane":
      if (source.origin === "deeplink" && source.target.kind === "lane") {
        return { kind: "lane", laneId: source.target.laneId };
      }
      return source.origin === "mention" && source.mentionKind === "lane"
        ? { kind: "lane", laneId: source.id }
        : null;
    case "chat":
      if (source.origin === "deeplink" && source.target.kind === "session") {
        return { kind: "chat", sessionId: source.target.sessionId };
      }
      return source.origin === "mention" && source.mentionKind === "chat"
        ? { kind: "chat", sessionId: source.id }
        : null;
    case "machine":
      return source.origin === "mention" && source.mentionKind === "machine"
        ? { kind: "machine", machineKey: source.id }
        : null;
    case "mcp":
      return source.origin === "mention" && source.mentionKind === "mcp" ? { kind: "mcp", name: source.id } : null;
    case "terminal":
      return source.origin === "mention" && source.mentionKind === "terminal"
        ? { kind: "terminal", sessionId: source.id }
        : null;
    case "model":
      return source.origin === "model"
        ? { kind: "model", modelId: source.mention.modelId, effort: source.mention.effort, permission: source.mention.permission }
        : null;
    case "permission":
      return source.origin === "permission" ? { kind: "permission", provider: source.provider, value: source.value } : null;
    case "skill":
      return source.origin === "skill" ? { kind: "skill", name: source.name } : null;
    case "artifact":
      return source.origin === "deeplink" && source.target.kind === "artifact"
        ? { kind: "artifact", artifactId: source.target.artifactId }
        : null;
    case "branch":
      return source.origin === "deeplink" && source.target.kind === "branch"
        ? { kind: "branch", branch: source.target.branch, repoOwner: source.target.repoOwner, repoName: source.target.repoName, prNumber: source.target.prNumber }
        : null;
    case "linear_issue":
      return chip.label.trim() ? { kind: "linear", identifier: chip.label.trim().toUpperCase() } : null;
    case "setting":
      return source.origin === "deeplink" && source.target.kind === "settings"
        ? { kind: "setting", entryId: source.target.entryId }
        : null;
    case "web_page": {
      if (source.origin !== "url") return null;
      try {
        return { kind: "link", host: new URL(source.url).hostname.replace(/^www\./i, "") };
      } catch {
        return null;
      }
    }
    case "issue": {
      const ref = source.origin === "url" ? issueRefFromUrl(source.url) : null;
      return ref?.provider === "github" ? { kind: "github-issue", owner: ref.owner, repo: ref.repo, number: ref.number } : null;
    }
    default:
      return null;
  }
}

/** Linear titles ADE already knows locally, from lanes that link the issue. */
function linearTitleFromLanes(lanes: LaneSummary[], identifier: string): string | null {
  for (const lane of lanes) {
    if (lane.linearIssue?.identifier?.toUpperCase() === identifier) return lane.linearIssue.title || null;
    for (const link of lane.linearIssueLinks ?? []) {
      if (link.issue?.identifier?.toUpperCase() === identifier) return link.issue.title || null;
    }
  }
  return null;
}

/**
 * Resolve one card's contents. `previewTitle` is the already-fetched smart-link
 * title for the same chip, so a Linear issue nobody has linked to a lane still
 * has something to show without a second round trip. `previewImageUrl` is the
 * same preview's og:image: the page card still shows its host without an
 * image, while the title adds context beyond the pill.
 */
export async function loadChipCardData(
  sources: ChipCardSources,
  target: ChipCardTarget,
  previewTitle: string | null,
  previewImageUrl: string | null = null,
): Promise<ChipCardData | null> {
  if (target.kind === "link") {
    return { kind: "link", host: target.host, title: previewTitle, imageUrl: previewImageUrl ?? "" };
  }
  if (target.kind === "commit") {
    const laneId = target.laneId ?? sources.laneId;
    const lane = laneId ? sources.lanes.find((candidate) => candidate.id === laneId) : null;
    if (!laneId || !lane) return null;
    const commit = await window.ade.git.getCommit({ laneId, commitSha: target.sha }, sources.pin).catch(() => null);
    if (!commit) return null;
    return {
      kind: "commit",
      subject: commit.subject,
      author: commit.authorName || "Unknown author",
      age: relativeWhen(commit.authoredAt),
      lane: lane.name,
    };
  }
  if (target.kind === "lane") {
    const lane = sources.lanes.find((candidate) => candidate.id === target.laneId);
    return lane
      ? { kind: "lane", name: lane.name, branch: lane.branchRef || null, archived: Boolean(lane.archivedAt) }
      : null;
  }
  if (target.kind === "chat") {
    const session = sources.sessions.find((candidate) => candidate.id === target.sessionId);
    if (!session) return null;
    return {
      kind: "chat",
      title: session.title || session.goal || "Untitled chat",
      lastActivity: session.lastActivityAt || session.endedAt || session.startedAt || null,
      lane: session.laneName || null,
      model: session.modelId ? getModelById(session.modelId)?.displayName ?? session.model ?? session.modelId : session.model || null,
      state: session.status === "running" ? "Running" : "Ended",
    };
  }
  if (target.kind === "machine") return { kind: "machine", machineKey: target.machineKey };
  if (target.kind === "mcp") {
    const result = await window.ade?.agentChat?.listMentionSuggestions?.(
      { query: `mcp ${target.name}`, ...(sources.sessionId ? { excludeSessionId: sources.sessionId } : {}) },
      sources.pin,
    );
    const mention = result?.suggestions.find((suggestion) => suggestion.kind === "mcp" && suggestion.id === target.name);
    if (!mention?.mcp) return null;
    return {
      kind: "mcp",
      name: mention.title,
      state: mention.mcp.state,
      transport: mention.mcp.transport,
      toolNames: mention.mcp.toolNames,
      toolCount: mention.mcp.toolCount ?? null,
      lastError: mention.mcp.lastError,
      lastErrorAt: mention.mcp.lastErrorAt ?? null,
    };
  }
  if (target.kind === "terminal") {
    const session = sources.sessions.find((candidate) => candidate.id === target.sessionId);
    if (!session) return null;
    return {
      kind: "terminal",
      title: session.title || session.goal || "Terminal",
      lane: session.laneName,
      tool: session.toolType || "Terminal",
      status: session.status === "running" ? "Running" : "Ended",
      startedAt: relativeWhen(session.startedAt),
    };
  }
  if (target.kind === "model") {
    const model = getModelById(target.modelId);
    return model ? {
      kind: "model",
      name: model.displayName,
      route: model.providerRoute,
      provider: resolveProviderGroupForModel(model),
      effort: target.effort,
      permission: target.permission,
    } : null;
  }
  if (target.kind === "permission") {
    const presentation = modelPermissionPresentation(target.provider, target.value);
    const risk = presentation.tone === "red" ? "high" : presentation.tone === "amber" ? "medium" : "low";
    const label = modelMentionPermissionLabel(target.value, target.provider);
    const meaning = risk === "high"
      ? `${label}: allows broad changes with fewer approval prompts.`
      : risk === "medium"
        ? `${label}: allows routine edits while keeping some actions gated.`
        : `${label}: keeps actions limited or asks before higher-impact changes.`;
    return { kind: "permission", meaning, risk };
  }
  if (target.kind === "setting") {
    // Read from this build's own lists, never the chat: nothing to fetch.
    const entry = settingsEntryById(target.entryId);
    if (!entry) return null;
    const access = settingAgentAccess(entry.id);
    return {
      kind: "setting",
      path: settingsEntryLabel(entry),
      ownerOnly: access.agent === "owner-only" ? access.explanation : null,
      locked: settingIsProtected(entry.id),
      unavailable: settingUnavailableReason(entry),
    };
  }
  if (target.kind === "skill") {
    if (!sources.sessionId) return { kind: "skill", name: target.name, description: null, source: "Slash command", argumentHint: null };
    const commands = await getAgentChatSlashCommandsCached({
      sessionId: sources.sessionId,
      laneId: sources.laneId,
      projectRoot: sources.rootPath,
    }, { pin: sources.pin }).catch(() => []);
    const command = commands.find((entry) => entry.name.replace(/^\//, "").toLowerCase() === target.name.toLowerCase());
    return command
      ? { kind: "skill", name: target.name, description: command.description || null, source: command.source === "local" ? "ADE" : command.origin ?? "Provider", argumentHint: command.argumentHint ?? null }
      : { kind: "skill", name: target.name, description: null, source: "Slash command", argumentHint: null };
  }
  if (target.kind === "artifact") {
    const records = await window.ade.computerUse.listArtifacts({ artifactId: target.artifactId, limit: 1 }, sources.pin).catch(() => [] as ComputerUseArtifactView[]);
    const artifact = records.find((row) => row.id === target.artifactId);
    if (!artifact) return null;
    return {
      kind: "artifact",
      artifact,
      artifactKind: artifact.kind.replace(/_/g, " "),
      createdAt: relativeWhen(artifact.createdAt),
    };
  }
  if (target.kind === "branch") {
    const lane = sources.lanes.find((candidate) => candidate.branchRef.toLowerCase() === target.branch.toLowerCase());
    const prs = await listPrsCoalesced({ pin: sources.pin, projectRoot: sources.rootPath }).catch(() => [] as Awaited<ReturnType<typeof listPrsCoalesced>>);
    const pull = prs.find((candidate) => candidate.repoOwner.toLowerCase() === target.repoOwner.toLowerCase()
      && candidate.repoName.toLowerCase() === target.repoName.toLowerCase()
      && candidate.headBranch.toLowerCase() === target.branch.toLowerCase()
      && (target.prNumber == null || candidate.githubPrNumber === target.prNumber));
    if (!lane && !pull) return null;
    return {
      kind: "branch",
      name: target.branch,
      lane: lane?.name ?? (pull ? sources.lanes.find((candidate) => candidate.id === pull.laneId)?.name : null) ?? `${target.repoOwner}/${target.repoName}`,
      pullRequest: pull ? `#${pull.githubPrNumber}` : null,
    };
  }
  if (target.kind === "github-issue") {
    const issue = peekGitHubIssue(sources.rootPath, target.owner, target.repo, target.number)
      ?? await loadGitHubIssue(sources.rootPath, target.owner, target.repo, target.number).catch(() => null);
    if (!issue || issue.isPullRequest) return null;
    return {
      kind: "github-issue",
      reference: `${issue.owner}/${issue.repo}#${issue.number}`,
      title: issue.title,
      state: issue.state,
      stateReason: issue.stateReason,
      assignees: issue.assignees.map((entry) => entry.login),
    };
  }
  if (target.kind === "linear") {
    const issue = peekLinearIssue(sources.rootPath, target.identifier)
      ?? await loadLinearIssue(sources.rootPath, target.identifier).catch(() => null);
    if (issue) {
      return {
        kind: "linear",
        identifier: issue.identifier,
        title: issue.title,
        stateName: issue.stateName,
        stateType: issue.stateType,
        assigneeName: issue.assigneeName,
      };
    }
    const title = linearTitleFromLanes(sources.lanes, target.identifier) ?? previewTitle;
    return title ? { kind: "linear", identifier: target.identifier, title } : null;
  }

  // Pinned so the read lands on the chat's machine: a PR row lives in the
  // `.ade` database of the machine that owns its lane, and an unpinned read
  // would query the project tab's machine for a row it does not have.
  const prs = await listPrsCoalesced({ pin: sources.pin, projectRoot: sources.rootPath })
    .catch(() => [] as Awaited<ReturnType<typeof listPrsCoalesced>>);
  const numbered = prs.filter((pr) => pr.githubPrNumber === target.number);
  const { owner, repo } = target;
  // Repository coordinates decide it whenever the chip carries them. When it
  // does not — a bare "#42" typed into the composer — the number alone is not
  // an identity: two repos in the project can each have a #42, and taking the
  // first row would put a confident WRONG title and state on the card. So a
  // number-only target resolves only when every candidate row is the same pull
  // request. (Rows are per lane — `pull_requests` is keyed by id with a lane
  // column — so one PR linked to two lanes is several rows and must still
  // resolve; it is distinct REPOSITORIES that make the number ambiguous.)
  const match = owner && repo
    ? numbered.find((pr) => pr.repoOwner?.toLowerCase() === owner.toLowerCase()
      && pr.repoName?.toLowerCase() === repo.toLowerCase())
    : new Set(numbered.map((pr) => `${pr.repoOwner ?? ""}/${pr.repoName ?? ""}`.toLowerCase())).size === 1
      ? numbered[0]
      : undefined;
  if (!match) return null;
  return {
    kind: "pr",
    number: match.githubPrNumber,
    title: match.title || null,
    state: match.state,
    repo: match.repoOwner && match.repoName ? `${match.repoOwner}/${match.repoName}` : null,
  };
}

const PR_STATE_DOT: Record<PrState, string> = {
  draft: "bg-white/40",
  open: "bg-emerald-400",
  merged: "bg-violet-400",
  closed: "bg-rose-400",
};

/** og:image width; the box is reserved at 1.91:1 (the Open Graph ratio) before bytes land. */
const LINK_IMAGE_WIDTH = 240;

function LinkCardBody({ data }: { data: Extract<ChipCardData, { kind: "link" }> }) {
  // Requested here, i.e. only once the card is open — never by the pill.
  const image = useChipPreviewImage(data.imageUrl);
  const [loaded, setLoaded] = useState(false);
  return (
    <div style={{ width: LINK_IMAGE_WIDTH }}>
      {data.imageUrl && image?.status !== "failed" ? (
        <div className="mb-1.5 aspect-[1.91/1] w-full overflow-hidden rounded-md bg-white/[0.05]">
          {image?.status === "ready" ? (
            <img
              src={image.dataUrl}
              alt=""
              draggable={false}
              onLoad={() => setLoaded(true)}
              className={`h-full w-full object-cover transition-opacity duration-200 ease-out ${loaded ? "opacity-100" : "opacity-0"}`}
            />
          ) : null}
        </div>
      ) : null}
      {data.title ? <div className="line-clamp-2 text-[12px] font-medium text-white/90">{data.title}</div> : null}
      <div className="mt-0.5 truncate text-[11px] text-white/55">{data.host}</div>
    </div>
  );
}

function ChipCardBody({ data }: { data: ChipCardData }) {
  if (data.kind === "link") return <LinkCardBody data={data} />;
  if (data.kind === "mcp") return <McpMentionCardBody {...data} />;
  if (data.kind === "machine") return <MachineChipCardBody machineKey={data.machineKey} />;
  if (data.kind === "terminal" || data.kind === "model" || data.kind === "permission" || data.kind === "skill" || data.kind === "artifact" || data.kind === "branch" || data.kind === "commit" || data.kind === "setting") {
    return <ExtraChipCardBody data={data} />;
  }
  if (data.kind === "pr") {
    return (
      <>
        <div className="flex items-center gap-1.5 text-[11px] text-fg/60">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${PR_STATE_DOT[data.state]}`} />
          <span className="font-medium text-fg/85">#{data.number}</span>
          <span className="capitalize">{data.state}</span>
          {data.repo ? <span className="truncate">· {data.repo}</span> : null}
        </div>
        {data.title ? <div className="mt-1 line-clamp-2 text-[12px] text-fg/90">{data.title}</div> : null}
      </>
    );
  }
  if (data.kind === "lane") {
    return (
      <>
        <div className="truncate text-[12px] font-medium text-fg/90">{data.name}{data.archived ? " · Archived" : ""}</div>
        {data.branch ? <div className="mt-0.5 truncate font-mono text-[11px] text-fg/55">{data.branch}</div> : null}
      </>
    );
  }
  if (data.kind === "chat") {
    return (
      <>
        <div className="line-clamp-2 text-[12px] font-medium text-fg/90">{data.title}</div>
        <div className="mt-0.5 truncate text-[11px] text-fg/55">
          {[data.lane, data.model, data.state].filter(Boolean).join(" · ")}
        </div>
        {data.lastActivity ? <div className="text-[11px] text-fg/45">Last activity {relativeWhen(data.lastActivity)}</div> : null}
      </>
    );
  }
  if (data.kind === "github-issue") {
    return (
      <>
        <div className="flex items-center gap-1.5 text-[11px] text-fg/60">
          <GitHubIssueStateIcon state={data.state} stateReason={data.stateReason} size={11} />
          <span className="truncate font-medium text-fg/85">{data.reference}</span>
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12px] text-fg/90">{data.title}</div>
        {data.assignees.length > 0 ? <div className="mt-0.5 truncate text-[11px] text-fg/55">{data.assignees.join(", ")}</div> : null}
      </>
    );
  }
  return (
    <>
      <div className="flex items-center gap-1.5 text-[11px] text-fg/60">
        {data.stateType ? <LinearStateIcon stateType={data.stateType} size={11} /> : null}
        <span className="font-medium text-fg/85">{data.identifier}</span>
        {data.stateName ? <span className="truncate">{data.stateName}</span> : null}
      </div>
      <div className="mt-0.5 line-clamp-2 text-[12px] text-fg/90">{data.title}</div>
      {data.assigneeName ? <div className="mt-0.5 truncate text-[11px] text-fg/55">{data.assigneeName}</div> : null}
    </>
  );
}

/** Where a chip card sits against its chip; shared with the composer machine card. */
export function cardPlacement(trigger: HTMLElement, card: HTMLElement): TooltipPlacement {
  // Screen rects and the window are converted into the frame the card is written in.
  const frame = fixedFrameOf(card.parentElement);
  const triggerBox = fixedRect(frame, trigger.getBoundingClientRect());
  const cardBox = fixedRect(frame, card.getBoundingClientRect());
  const viewport = fixedViewport(frame);
  return computeTooltipPosition({
    preferredSide: "top",
    trigger: {
      top: triggerBox.top,
      left: triggerBox.left,
      right: triggerBox.right,
      bottom: triggerBox.bottom,
      width: triggerBox.width,
      height: triggerBox.height,
    },
    tooltip: { width: cardBox.width, height: cardBox.height },
    viewport: { width: viewport.width, height: viewport.height },
    gap: GAP,
    pad: VIEWPORT_PAD,
  });
}

export type ChipHoverCard = {
  /** True when this chip has a card or a menu at all — drives the native-title swap. */
  supported: boolean;
  /** True while the card is on screen. */
  visible: boolean;
  triggerRef: (node: HTMLElement | null) => void;
  /** Spread onto the chip element; none of them move focus on hover. */
  triggerProps: {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onContextMenu?: (event: ReactMouseEvent) => void;
    onKeyDown?: (event: ReactKeyboardEvent) => void;
    "aria-describedby"?: string;
    "aria-haspopup"?: "menu";
  };
  /** Open the card with its actions now, e.g. a click on a chip whose click IS the card. */
  openMenu: () => void;
  /** Portal node. Render it as a sibling of the chip; it is out of flow. */
  card: ReactNode;
};

/**
 * Hover-card behavior for one chip, returned as props to spread rather than a
 * wrapper element: a chip lives inline in flowing prose, and wrapping it in a
 * positioned box would change how the sentence wraps around it.
 *
 * Two stages, so a skim never turns into a menu:
 *
 *   - **Peek** (`HOVER_DELAY_MS`): the facts card, inert and click-through,
 *     exactly the tooltip it always was.
 *   - **Menu** (`MENU_DWELL_MS`, a right-click, Shift+F10, or `openMenu`): the
 *     same card gains the chip's actions under its facts and starts taking the
 *     pointer, so the user can move onto it. A chip with no facts card (a
 *     machine, a skill) shows only the actions. Hover still never moves focus;
 *     a keyboard open does, so arrow-less Tab reaches the rows.
 *
 * `menuEntries` is a builder, not a list: it runs only when a menu opens, so a
 * transcript of hundreds of pills builds no rows until one is held.
 */
export function useChipHoverCard(
  chip: Chip,
  previewTitle: string | null,
  /**
   * The chat machine's lanes and sessions, resolved once by the chip (see
   * `useChipScopeSources`) and shared with its label, so a transcript of
   * hundreds of pills subscribes to each list once per pill, not twice.
   */
  scoped: ChipScopeSources,
  previewImageUrl: string | null = null,
  menuEntries: (() => ContextMenuEntry[]) | null = null,
): ChipHoverCard {
  const cardId = useId();
  const scope = useChatRuntimeScope();
  const scopedLanes = scoped.lanes;
  const scopedSessions = scoped.sessions;
  // Held in a ref, not in the effect's deps: a lane-status refresh replaces
  // these arrays constantly, and depending on them would reload an open card on
  // every tick. This is the ref form the chat-scope lint rule sanctions.
  const sourcesRef = useRef<ChipCardSources>({ lanes: EMPTY_LANES, sessions: EMPTY_SESSIONS, pin: null, rootPath: null, sessionId: null, laneId: null });
  sourcesRef.current = {
    lanes: scopedLanes ?? EMPTY_LANES,
    sessions: scopedSessions ?? EMPTY_SESSIONS,
    pin: scope.pin,
    rootPath: scope.rootPath,
    sessionId: scope.sessionId,
    laneId: scope.laneId,
  };
  const menuEntriesRef = useRef(menuEntries);
  menuEntriesRef.current = menuEntries;
  const hasMenu = menuEntries !== null;
  // A stable key, so re-pinning the chat reloads an open card without the
  // binding object's identity churn doing it on every merge.
  const pinKey = scope.pin?.key ?? null;

  // `chip` is stable per message (memoized parse), so a PR chip parses its
  // GitHub URL once rather than on every re-render of the transcript.
  const target = useMemo(() => chipCardTarget(chip), [chip]);
  const commitLaneName = target?.kind === "commit"
    ? scopedLanes?.find((lane) => lane.id === (target.laneId ?? scope.laneId))?.name ?? null
    : null;
  const supported = target !== null || hasMenu;

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"peek" | "menu">("peek");
  const [entries, setEntries] = useState<ContextMenuEntry[]>([]);
  const [data, setData] = useState<ChipCardData | null>(null);
  const [coords, setCoords] = useState<TooltipPlacement | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusMenuRef = useRef(false);

  const clearTimers = useCallback(() => {
    for (const ref of [showTimerRef, menuTimerRef, hideTimerRef]) {
      if (ref.current === null) continue;
      clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
    setMode("peek");
    setCoords(null);
  }, [clearTimers]);

  const enterMenu = useCallback((focus: boolean) => {
    const build = menuEntriesRef.current;
    if (!build) return;
    const rows = build();
    if (rows.length === 0) return;
    clearTimers();
    focusMenuRef.current = focus;
    setEntries(rows);
    setMode("menu");
    setOpen(true);
  }, [clearTimers]);

  const openPeek = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const onMouseEnter = useCallback(() => {
    // Back onto the chip from its own card: keep what is open.
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (open && mode === "menu") return;
    if (showTimerRef.current === null && !open && target) {
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        setOpen(true);
      }, HOVER_DELAY_MS);
    }
    if (menuEntriesRef.current && menuTimerRef.current === null) {
      menuTimerRef.current = setTimeout(() => {
        menuTimerRef.current = null;
        enterMenu(false);
      }, MENU_DWELL_MS);
    }
  }, [enterMenu, mode, open, target]);

  const onMouseLeave = useCallback(() => {
    if (showTimerRef.current !== null) clearTimeout(showTimerRef.current);
    if (menuTimerRef.current !== null) clearTimeout(menuTimerRef.current);
    showTimerRef.current = null;
    menuTimerRef.current = null;
    if (!open) return;
    if (mode !== "menu") {
      close();
      return;
    }
    // A menu card is something to move onto, so give the pointer time to
    // cross the gap; entering the card cancels this.
    hideTimerRef.current = setTimeout(close, MENU_LEAVE_GRACE_MS);
  }, [close, mode, open]);

  useEffect(() => clearTimers, [clearTimers]);

  // Load on demand. Two hundred chips in a transcript must cost zero reads
  // until one of them is actually hovered.
  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    void loadChipCardData(sourcesRef.current, target, previewTitle, previewImageUrl)
      .catch(() => null)
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, previewTitle, previewImageUrl, pinKey, scope.laneId, commitLaneName]);

  // Escape dismisses, and any scroll does too: the card is absolutely placed
  // against a trigger that a scrolling transcript moves out from under it. A
  // menu also closes on a press anywhere outside it and its chip.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const restoreFocus = mode === "menu" && cardRef.current?.contains(document.activeElement);
      close();
      if (restoreFocus) triggerElementRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && (cardRef.current?.contains(node) || triggerElementRef.current?.contains(node))) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    if (mode === "menu") window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, mode, close]);

  const showCard = open && (data !== null || (mode === "menu" && entries.length > 0));

  useLayoutEffect(() => {
    if (!showCard) return;
    const trigger = triggerElementRef.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const place = () => {
      const next = cardPlacement(trigger, card);
      setCoords((prev) => (
        prev && prev.x === next.x && prev.y === next.y && prev.side === next.side ? prev : next
      ));
    };
    place();
    // The card changes size after it is placed — a link image fails and its box
    // collapses, the facts land after the menu rows, a peek grows into a menu —
    // so re-place to keep it attached to its chip instead of floating.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(card);
    return () => observer.disconnect();
  }, [showCard, data, mode]);

  // A keyboard open puts focus on the first row; a hover open never does.
  useEffect(() => {
    if (!showCard || mode !== "menu" || !coords || !focusMenuRef.current) return;
    focusMenuRef.current = false;
    cardRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [showCard, mode, coords]);

  const triggerRef = useCallback((node: HTMLElement | null) => {
    triggerElementRef.current = node;
  }, []);

  const isMenu = mode === "menu" && entries.length > 0;
  const visible = supported && showCard;

  const card = showCard && typeof document !== "undefined"
    ? createPortal(
        // The host owns the viewport anchoring and the tooltip layer; the card
        // is placed inside it at the viewport point computeTooltipPosition gave.
        <ViewportOverlayHost layer="tooltip">
          <div
            ref={cardRef}
            id={cardId}
            role={isMenu ? "menu" : "tooltip"}
            aria-label={isMenu ? chip.label : undefined}
            data-chip-hover-card={data?.kind ?? "menu"}
            className={
              `${isMenu ? "pointer-events-auto min-w-[200px]" : "pointer-events-none"} absolute max-w-[300px] rounded-lg border border-fg/12`
              + " bg-(color:--work-popover-bg) px-2.5 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm"
            }
            style={{
              top: coords?.y ?? 0,
              left: coords?.x ?? 0,
              // Measured before it is placed: keep the first frame invisible so
              // the card never flashes at the top-left corner of the window.
              visibility: coords ? "visible" : "hidden",
            }}
            onMouseEnter={isMenu ? () => {
              if (hideTimerRef.current === null) return;
              clearTimeout(hideTimerRef.current);
              hideTimerRef.current = null;
            } : undefined}
            onMouseLeave={isMenu ? () => {
              hideTimerRef.current = setTimeout(close, MENU_LEAVE_GRACE_MS);
            } : undefined}
            onContextMenu={isMenu ? (event) => event.preventDefault() : undefined}
          >
            {data ? <ChipCardBody data={data} /> : null}
            {isMenu ? (
              <div className={`-mx-1.5 ${data ? "mt-2 border-t border-fg/10 pt-1" : "-my-1"}`}>
                <ContextMenuRows entries={entries} onClose={close} />
              </div>
            ) : null}
          </div>
        </ViewportOverlayHost>,
        document.body,
      )
    : null;

  if (!supported) {
    return { supported: false, visible: false, triggerRef, triggerProps: {}, openMenu: () => {}, card: null };
  }

  return {
    supported: true,
    visible,
    triggerRef,
    triggerProps: {
      onMouseEnter,
      onMouseLeave,
      // Keyboard parity: tabbing onto a chip shows its card immediately. The
      // peek itself is inert, so focus stays exactly where the user put it.
      onFocus: target ? () => {
        if (!open) openPeek();
      } : undefined,
      onBlur: () => {
        // Focus moving into the open menu is not a blur that should close it.
        requestAnimationFrame(() => {
          if (cardRef.current?.contains(document.activeElement)) return;
          if (mode === "menu" && cardRef.current?.matches(":hover")) return;
          close();
        });
      },
      ...(hasMenu ? {
        "aria-haspopup": "menu" as const,
        onContextMenu: (event: ReactMouseEvent) => {
          event.preventDefault();
          // The transcript row's own menu must not open on top of this one.
          event.stopPropagation();
          enterMenu(false);
        },
        onKeyDown: (event: ReactKeyboardEvent) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault();
            enterMenu(true);
          }
        },
      } : {}),
      ...(visible ? { "aria-describedby": cardId } : {}),
    },
    openMenu: () => enterMenu(true),
    card,
  };
}
