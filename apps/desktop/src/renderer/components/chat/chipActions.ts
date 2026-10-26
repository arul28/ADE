// What a transcript chip DOES: its click, and the kind-specific rows of its
// menu. `ChipText` draws the pill; `chipMenu` lays the rows out; this module
// decides where each kind goes.
//
// Every route here is the CHAT's: lanes, sessions and PR rows come from the
// chat machine's scoped lists, and every preload call carries `scope.pin`. A
// lane or session id is only unique per machine, so resolving one against the
// project tab's lists could open a different entity that shares the id.

import { ChatCircleDots, Copy, PencilSimple, Plugs } from "@phosphor-icons/react";

import type { Chip } from "../../../shared/chips";
import type { DeeplinkPrTarget } from "../../../shared/deeplinks";
import { machineIdForBinding } from "../../../shared/machineIdentity";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { navigateToAppTarget, openExternalUrl, openLinkFromUi } from "../../lib/openExternal";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { focusWorkSession } from "../../lib/workSessionRequests";
import { chatDraftMachineId, openStartChatDraft } from "../../lib/workDraft";
import { laneOwnedByBranch } from "../app/InboundDeeplinkModal";
import { showToast } from "../app/toast/toastStore";
import { isComputerSettingsEntry, settingsEntryById, settingsRouteFor, settingUnavailableReason } from "../settings/settingsManifest";
import { requestWorkTool } from "../terminals/workToolRequests";
import { rootAppStoreApi, selectActiveProjectStateKey } from "../../state/appStore";
import type { ContextMenuEntry } from "../ui/ContextMenu";
import type { ChatRuntimeScope } from "./ChatRuntimeScope";
import { chatMachineId, chatSettingsMachineId, openChatDeeplinkTarget } from "./chatDeeplinks";
import { openPrInChatToolsPane } from "./chatPrPaneRequests";
import type { ChatWorkspacePathOpener } from "./chatWorkspacePaths";
import type { MachineFacts } from "./useMachineFacts";

export type ChipActionContext = {
  scope: ChatRuntimeScope;
  lanes: LaneSummary[] | null;
  sessions: TerminalSessionSummary[] | null;
  openWorkspacePath: ChatWorkspacePathOpener | null;
  /** A `@pr:` mention's resolved row, once known. */
  prTarget: DeeplinkPrTarget | null;
  machineFacts: MachineFacts | null;
  /** Opens the chip's own card with its menu; a machine chip's click. */
  openMenu: () => void;
};

function mentionOf(chip: Chip, kind: string): string | null {
  return chip.source.origin === "mention" && chip.source.mentionKind === kind ? chip.source.id : null;
}

function findById<T extends { id: string }>(rows: T[] | null, id: string): T | null {
  const needle = id.toLowerCase();
  return rows?.find((row) => row.id.toLowerCase() === needle) ?? null;
}

type PullRequestChipTarget = { number: number; owner: string | null; repo: string | null };

function pullRequestTarget(chip: Chip, prTarget: DeeplinkPrTarget | null): PullRequestChipTarget | null {
  const source = chip.source;
  if (source.origin === "deeplink" && source.target.kind === "pr") {
    const target = source.target;
    return { number: target.prNumber, owner: target.repoOwner ?? null, repo: target.repoName ?? null };
  }
  if (source.origin === "url") {
    const match = source.url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
    if (match) return { owner: match[1]!, repo: match[2]!.replace(/\.git$/i, ""), number: Number(match[3]) };
  }
  if (prTarget) {
    return { number: prTarget.prNumber, owner: prTarget.repoOwner ?? null, repo: prTarget.repoName ?? null };
  }
  return null;
}

/**
 * A PR opens where it is being worked on: the chat linked to it (this chat when
 * it sits in the PR's lane, else the lane's most recent chat) with the PR in its
 * tools pane; else ADE's PR page; else GitHub.
 */
async function openPullRequest(
  target: PullRequestChipTarget,
  context: ChipActionContext,
  /** What the chip did before this lookup existed, for a PR ADE has no row for. */
  fallback: () => void,
): Promise<void> {
  const { scope } = context;
  // A missing bridge throws synchronously; either way the chip falls back.
  const prs = await Promise.resolve()
    .then(() => listPrsCoalesced({ pin: scope.pin, projectRoot: scope.rootPath }))
    .catch((error: unknown) => {
      // The chip still opens (GitHub, or its own route); note why it skipped ADE.
      console.warn("[chips] PR lookup failed; opening the link directly", error);
      return [];
    });
  const sameRepo = (owner: string, repo: string) =>
    (!target.owner || owner.toLowerCase() === target.owner.toLowerCase())
    && (!target.repo || repo.toLowerCase() === target.repo.toLowerCase());
  const pr = prs.find((row) => row.githubPrNumber === target.number && sameRepo(row.repoOwner, row.repoName)) ?? null;
  if (!pr) {
    fallback();
    return;
  }
  const lane = context.lanes?.find((row) => row.id === pr.laneId) ?? null;
  if (lane) {
    const chats = (context.sessions ?? []).filter((row) => row.laneId === lane.id && !row.ptyId);
    const session = scope.sessionId && scope.laneId === lane.id
      ? { id: scope.sessionId }
      : [...chats].sort((a, b) =>
        Date.parse(b.lastActivityAt ?? b.startedAt) - Date.parse(a.lastActivityAt ?? a.startedAt))[0] ?? null;
    if (session) {
      if (session.id !== scope.sessionId) navigateToAppTarget({ kind: "chat", sessionId: session.id, laneId: lane.id });
      openPrInChatToolsPane({ laneId: lane.id, sessionId: session.id, prId: pr.id });
      return;
    }
  }
  navigateToAppTarget({ kind: "pr", prId: pr.id, prNumber: pr.githubPrNumber, repoOwner: pr.repoOwner, repoName: pr.repoName });
}

/** True when a click on the chip does something. */
export function isChipActionable(chip: Chip, context: Pick<ChipActionContext, "prTarget">): boolean {
  if (chip.kind === "model" || chip.kind === "permission" || chip.kind === "skill") return false;
  if (chip.source.origin !== "mention") return true;
  // A `@pr:` mention is an ADE row id; it is clickable once the row resolves.
  if (chip.source.mentionKind === "pr") return context.prTarget !== null;
  return true;
}

/** The chip's click. */
export function openChipTarget(chip: Chip, context: ChipActionContext): void {
  const { scope } = context;
  const source = chip.source;

  const pr = pullRequestTarget(chip, context.prTarget);
  if (pr) {
    // Unknown here: a link goes to GitHub, an `ade://pr` / bare `#123` keeps its
    // own route (which also tells an issue number from a PR number).
    void openPullRequest(pr, context, () => {
      if (source.origin === "deeplink") openChatDeeplinkTarget(source.url, source.target, scope);
      else if (source.origin === "url") openLinkFromUi(source.url, null, { runtimePin: scope.pin });
      else if (pr.owner && pr.repo) openExternalUrl(`https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`);
    });
    return;
  }
  if (chip.kind === "ade_link") {
    showToast({
      title: "Made by a newer ADE",
      message: "Update ADE to open this link here.",
      actions: [{ label: "Copy link", variant: "secondary", onClick: () => void copyTextToClipboard(chip.token) }],
    });
    return;
  }
  if (source.origin === "deeplink") {
    const target = source.target;
    if (target.kind === "artifact") {
      window.dispatchEvent(new CustomEvent("ade:chat:open-artifact", {
        detail: { sessionId: scope.sessionId, artifactId: target.artifactId },
      }));
      return;
    }
    if (target.kind === "branch") {
      // The lane already on this branch, before offering to create one.
      const lane = laneOwnedByBranch(context.lanes ?? [], target.branch);
      if (lane) {
        navigateToAppTarget({ kind: "lane", laneId: lane.id, machineId: chatMachineId(scope) });
        return;
      }
    }
    if (target.kind === "settings") {
      openSettingFromChat(target.entryId, target.machineId ?? null, scope);
      return;
    }
    if (target.kind === "open") {
      navigateToAppTarget({ kind: "open-place", place: target.place });
      return;
    }
    if (target.kind === "session") {
      const session = findById(context.sessions, target.sessionId);
      navigateToAppTarget({ kind: "chat", sessionId: target.sessionId, laneId: session?.laneId ?? null });
      return;
    }
    openChatDeeplinkTarget(source.url, target, scope);
    return;
  }
  if (source.origin === "url") {
    openLinkFromUi(source.url, null, { runtimePin: scope.pin });
    return;
  }
  if (source.origin === "path") {
    // Inside a chat, a path (file or folder) is relative to the chat's lane on
    // the chat's machine; the bare route would use the tab's project root.
    if (context.openWorkspacePath) context.openWorkspacePath(source.path);
    else if (chip.kind === "file") navigateToAppTarget({ kind: "file", path: source.path, line: null, laneId: null });
    return;
  }
  if (source.origin === "browser_tab") {
    void window.ade?.builtInBrowser?.switchTab({ tabId: source.tabId }, scope.pin)
      .then(() => requestWorkTool("browser"))
      .catch(() => undefined);
    return;
  }
  if (source.origin !== "mention") return;
  switch (source.mentionKind) {
    case "chat": {
      // The TARGET chat's lane, not this chat's: the Work page selects it.
      const session = findById(context.sessions, source.id);
      navigateToAppTarget({ kind: "chat", sessionId: source.id, laneId: session?.laneId ?? null });
      return;
    }
    case "lane":
      navigateToAppTarget({ kind: "lane", laneId: source.id, machineId: chatMachineId(scope) });
      return;
    case "terminal": {
      const session = findById(context.sessions, source.id);
      if (session) focusWorkSession(session.id, session.laneId, scope.pin);
      return;
    }
    case "machine":
      context.openMenu();
      return;
    case "mcp":
      openMcpSettings(source.id);
      return;
    default:
      return;
  }
}

/**
 * A settings chip's click: the card, on the chat's machine when it is a
 * Computer page (Providers in a chat on Studio opens Studio's Providers), or on
 * the machine the link names. Project pages stay on the project's machine. A
 * setting this window cannot show says why instead of opening nothing.
 */
function openSettingFromChat(entryId: string, linkMachineId: string | null, scope: ChatRuntimeScope): void {
  const entry = settingsEntryById(entryId);
  if (!entry) {
    navigateToAppTarget({ kind: "settings" });
    return;
  }
  const unavailable = settingUnavailableReason(entry);
  if (unavailable) {
    showToast({ title: entry.label, message: unavailable });
    return;
  }
  navigateToAppTarget({
    kind: "settings",
    entryId: entry.id,
    // A link that names its machine opens that one, as it does from outside ADE.
    machineId: isComputerSettingsEntry(entry) ? linkMachineId ?? chatSettingsMachineId(scope) : null,
  });
}

function openMcpSettings(serverName: string): void {
  // The servers list scrolls to and highlights `mcpServer` once it renders.
  const url = new URL(settingsRouteFor("mcp.servers"), "http://ade.local");
  url.searchParams.set("mcpServer", serverName);
  navigateToAppTarget({ kind: "route", route: `${url.pathname}${url.search}${url.hash}` });
}

/** Rows a kind adds after its primary row; see `buildChipMenuEntries`. */
export function chipMenuExtras(chip: Chip, context: ChipActionContext): ContextMenuEntry[] {
  const laneId = context.scope.laneId;
  if (chip.source.origin === "model" && laneId && context.scope.online) {
    const { mention } = chip.source;
    return [{
      kind: "item",
      key: "new-chat-with-model",
      label: "New chat with this model",
      icon: ChatCircleDots,
      tone: "blue",
      onSelect: () => {
        const state = rootAppStoreApi.getState();
        const projectStateKey = selectActiveProjectStateKey(state);
        if (!projectStateKey) return;
        openStartChatDraft(
          state.setWorkViewState,
          projectStateKey,
          laneId,
          chatDraftMachineId(chatMachineId(context.scope), machineIdForBinding(state.projectBinding)),
          {
            modelId: mention.modelId,
            reasoningEffort: mention.effort,
            permission: mention.permission,
          },
        );
        navigateToAppTarget({ kind: "work" });
      },
    }];
  }
  if (mentionOf(chip, "machine")) {
    const facts = context.machineFacts;
    const machineKey = facts?.machineKey ?? mentionOf(chip, "machine")!;
    const rows: ContextMenuEntry[] = [{
      kind: "item",
      key: "open-connections",
      label: "Open in Connections",
      icon: Plugs,
      tone: "teal",
      onSelect: () => openConnectionsPanel({ tab: "machines", machineId: machineKey }),
    }];
    if (facts?.address) {
      const address = facts.address;
      rows.push({
        kind: "item",
        key: "copy-address",
        label: "Copy address",
        icon: Copy,
        onSelect: () => void copyTextToClipboard(address),
      });
    }
    return rows;
  }
  if (chip.source.origin === "skill" && context.scope.sessionId) {
    const text = `/${chip.source.name} `;
    const sessionId = context.scope.sessionId;
    return [{
      kind: "item",
      key: "use-in-prompt",
      label: "Use in prompt",
      icon: PencilSimple,
      tone: "violet",
      onSelect: () => window.dispatchEvent(new CustomEvent("ade:agent-chat:insert-draft", { detail: { sessionId, text } })),
    }];
  }
  return [];
}
