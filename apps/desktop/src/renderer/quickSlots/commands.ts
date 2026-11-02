import type { Icon } from "@phosphor-icons/react";
import {
  ArrowSquareOut,
  Brain,
  ChatCircle,
  CloudArrowUp,
  Command,
  Copy,
  CursorText,
  Desktop,
  Files,
  Gear,
  GitBranch,
  GithubLogo,
  Globe,
  Lightning,
  Monitor,
  Plus,
  Stop,
  Terminal,
  Ticket,
  WindowsLogo,
} from "@phosphor-icons/react";
import { AppleLogo } from "../components/ui/appleIcons";
import type { KeybindingsSnapshot, LaneSummary } from "../../shared/types";
import {
  QUICK_SLOT_COMMAND_IDS,
  modelProfileMentionToken,
  reasoningEffortLabel,
  type ModelProfile,
  type QuickSlotArgs,
  type QuickSlotKind,
  type QuickSlotNeeds,
  type QuickSlotSafety,
} from "../../shared/quickSlots";
import { showToast } from "../components/app/toast/toastStore";
import { promptDialog } from "../components/ui/dialog";
import {
  lanePrTagRoutePath,
  selectLaneTabPrTag,
} from "../components/lanes/lanePageModel";
import { focusWorkInputSoon } from "../components/work/workShortcuts";
import { fireBinding, getEffectiveBinding } from "../lib/keybindings";
import { getGitHubSnapshotCoalesced, listPrsCoalesced } from "../lib/prReadCache";
import { openStartChatDraft } from "../lib/workDraft";
import {
  laneWorkViewScopeKey,
  projectStateKeyForBinding,
  selectActiveProjectStateKey,
  selectActiveProjectRoot,
  useAppStore,
  type WorkSidebarTab,
} from "../state/appStore";
import type { QuickSlotComposerTarget } from "./composerTarget";
import { newModelProfileId, useQuickSlotsStore } from "./quickSlotsStore";

export type QuickSlotAvailability =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: string };

export type QuickSlotContext = {
  navigate: (to: string) => void;
  keybindings: KeybindingsSnapshot | null;
  /** The lane the front surface is about, if any. */
  lane: LaneSummary | null;
  /** The composer that claimed the last caret, if one is on screen. */
  composer: QuickSlotComposerTarget | null;
  /** Whether the caret was inside that composer when the panel opened. */
  caretInsideComposer: boolean;
  /** Why no lane could be resolved (a chat whose lane lives elsewhere). */
  laneUnavailableReason?: string | null;
};

export type QuickSlotCommand = {
  id: string;
  title: string;
  hint?: string;
  group: "Chat" | "Model" | "Lane" | "Tools" | "Navigate";
  kind: QuickSlotKind;
  needs: QuickSlotNeeds;
  safety: QuickSlotSafety;
  icon: Icon;
  keywords?: string[];
  /** Dynamic commands (a saved profile) carry their own arguments. */
  args?: QuickSlotArgs;
  enabled?: (context: QuickSlotContext) => QuickSlotAvailability;
  run: (context: QuickSlotContext, args?: QuickSlotArgs) => void | Promise<void>;
};

const IN_CHAT = (context: QuickSlotContext): QuickSlotAvailability =>
  context.composer ? { ok: true } : { ok: false, reason: "Open a chat first" };

const WITH_LANE = (context: QuickSlotContext): QuickSlotAvailability =>
  context.lane
    ? { ok: true }
    : { ok: false, reason: context.laneUnavailableReason ?? "Select a lane first" };

const WITH_PROJECT = (): QuickSlotAvailability => {
  const state = useAppStore.getState();
  return projectStateKeyForBinding(state.projectBinding, state.project?.rootPath)
    ? { ok: true }
    : { ok: false, reason: "Open a project first" };
};

function activeProjectStateKey(): string | null {
  const state = useAppStore.getState();
  return projectStateKeyForBinding(state.projectBinding, state.project?.rootPath) || null;
}

function toast(title: string, message?: string, tone: "info" | "success" | "warning" | "error" = "info"): void {
  showToast({ title, ...(message ? { message } : {}), tone });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The strip rule from `useWorkSidebarTool`: re-picking an open tool keeps its tab. */
function openWorkToolTab(
  openTools: readonly WorkSidebarTab[],
  tool: WorkSidebarTab,
): WorkSidebarTab[] {
  return openTools.includes(tool) ? [...openTools] : [...openTools, tool];
}

/** The quick-slot work-tool write, mirroring `useWorkSidebarTool.setTool`. */
function openWorkTool(tool: WorkSidebarTab, laneIdOverride?: string | null): void {
  const state = useAppStore.getState();
  const projectKey = selectActiveProjectStateKey(state);
  if (!projectKey) {
    toast("Open a project first", "Work tools belong to a project.", "warning");
    return;
  }
  const toolStateKey = projectStateKeyForBinding(state.projectBinding, projectKey) || projectKey;
  const laneId = (laneIdOverride === undefined ? state.selectedLaneId : laneIdOverride)?.trim() || null;
  const scopeKey = laneWorkViewScopeKey(toolStateKey, laneId);
  const view = (scopeKey ? state.laneWorkViewByScope?.[scopeKey] : undefined)
    ?? state.workViewByProject?.[toolStateKey]
    ?? state.workViewByProject?.[projectKey];
  const openTools = view?.workSidebarOpenTools ?? [];
  const next = {
    workSidebarTool: tool,
    workSidebarOpenTools: openWorkToolTab(openTools, tool),
  };
  if (laneId) state.setLaneWorkViewState(toolStateKey, laneId, next);
  else state.setWorkViewState(toolStateKey, next);
  state.setWorkViewState(toolStateKey, { workSidebarOpen: true });
}

function openStartChat(context: QuickSlotContext): void {
  const state = useAppStore.getState();
  const projectKey = activeProjectStateKey();
  if (!projectKey) {
    toast("Open a project first", "A chat needs a project and a lane.", "warning");
    return;
  }
  const laneId = (context.lane?.id ?? state.selectedLaneId)?.trim() || "";
  openStartChatDraft(state.setWorkViewState, projectKey, laneId, null);
  context.navigate("/work");
}

function jumpToWorkAndFocus(context: QuickSlotContext): void {
  context.navigate("/work");
  focusWorkInputSoon();
}

function toolCommand(id: WorkSidebarTab, title: string, icon: Icon, needs: QuickSlotNeeds): QuickSlotCommand {
  return {
    id: `tool.${id}`,
    title,
    group: "Tools",
    kind: "go",
    needs,
    safety: "instant",
    icon,
    keywords: ["work", "pane", "panel", "tool"],
    enabled: needs === "lane" ? WITH_LANE : undefined,
    run: (context) => {
      context.navigate("/work");
      openWorkTool(id, context.lane?.id ?? null);
    },
  };
}

/** One notch up or down this model's own thinking tiers, clamped at the ends. */
function thinkingCommand(direction: 1 | -1): QuickSlotCommand {
  const up = direction > 0;
  return {
    id: up ? QUICK_SLOT_COMMAND_IDS.modelCycleThinking : QUICK_SLOT_COMMAND_IDS.modelThinkingDown,
    title: up ? "Thinking level up" : "Thinking level down",
    hint: up
      ? "One notch up this model's own tiers; stops at the top."
      : "One notch down this model's own tiers; stops at the bottom.",
    group: "Model",
    kind: "set",
    needs: "chat",
    safety: "instant",
    icon: Lightning,
    keywords: ["reasoning", "effort", "thinking", up ? "raise" : "lower"],
    enabled: (context) => {
      if (!context.composer) return { ok: false, reason: "Open a chat first" };
      return context.composer.getSnapshot().modelLocked
        ? { ok: false, reason: "Wait for this turn to end" }
        : { ok: true };
    },
    run: (context) => {
      const result = context.composer?.cycleReasoningEffort(direction);
      if (!result) {
        toast("This model has no thinking levels", "Pick a model that offers reasoning tiers.", "warning");
        return;
      }
      if (result.from === result.to) {
        toast(
          `Already at ${result.to ? reasoningEffortLabel(result.to) : "Default"}`,
          up ? "This model's highest thinking level is selected." : "This model's lowest thinking level is selected.",
          "info",
        );
        return;
      }
      toast(`Thinking: ${result.to ? reasoningEffortLabel(result.to) : "Default"}`, "Applies to your next message.");
    },
  };
}

/**
 * Apply a saved profile.
 *
 * The focus branch is the whole point: the caret in the prompt means "name this
 * model in my instruction", the caret anywhere else means "run this chat on
 * it". A model change on a running chat is deferred by the composer to the
 * next send, which is why the toast says so.
 */
async function runApplyProfile(context: QuickSlotContext, args?: QuickSlotArgs): Promise<void> {
  const profileId = args?.profileId;
  if (!profileId) return;
  const composer = context.composer;
  if (!composer) return;
  const profile = useQuickSlotsStore.getState().profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    toast("That profile is gone", "Pick another action for this slot.", "warning");
    return;
  }
  const snapshot = composer.getSnapshot();
  const preferences = useQuickSlotsStore.getState();
  if (context.caretInsideComposer && preferences.profileCaretBehavior === "insert") {
    // A mention is text: it is safe to write while a turn runs, because it
    // only becomes an instruction when this draft is sent.
    const token = modelProfileMentionToken(profile, snapshot.permission);
    composer.insertText(`${token} `);
    toast(`${profile.name} inserted`, "The agent will use it when it starts that work.", "success");
    return;
  }
  if (snapshot.modelLocked) {
    toast("Wait for this turn to end", "The model cannot change while an agent is working.", "warning");
    return;
  }
  const before = { modelId: snapshot.modelId, reasoningEffort: snapshot.reasoningEffort };
  const applied = composer.setModel(profile.modelId);
  if (!applied) {
    toast("That model is not available here", `${profile.name} is not offered by this chat's machine.`, "warning");
    return;
  }
  composer.setReasoningEffort(profile.reasoningEffort);
  showToast({
    title: `${profile.name} is now this chat's model`,
    message: snapshot.provider && profile.modelId !== snapshot.modelId
      ? "Applies to your next message. If this changes harnesses, the thread's runtime context ends."
      : "Applies to your next message.",
    tone: "success",
    actions: before.modelId
      ? [{
          label: "Undo",
          onClick: () => {
            const target = context.composer;
            if (!target) return;
            target.setModel(before.modelId!);
            target.setReasoningEffort(before.reasoningEffort);
          },
        }]
      : undefined,
  });
}

export const QUICK_SLOT_COMMANDS: readonly QuickSlotCommand[] = [
  // ── Chat ────────────────────────────────────────────────────────────────
  {
    id: QUICK_SLOT_COMMAND_IDS.chatNew,
    title: "New chat",
    hint: "In the selected lane, or a fresh lane if none is selected.",
    group: "Chat",
    kind: "run",
    needs: "none",
    safety: "instant",
    icon: Plus,
    keywords: ["start", "conversation", "compose"],
    enabled: (context) => {
      const composerLaneId = context.composer?.getSnapshot().laneId ?? null;
      if (composerLaneId && !context.lane) {
        return { ok: false, reason: "This chat's lane is on another machine" };
      }
      return WITH_PROJECT();
    },
    run: (context) => openStartChat(context),
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.chatFocusComposer,
    title: "Jump into the prompt box",
    hint: "Goes to Work and puts the caret in the chat's composer.",
    group: "Chat",
    kind: "go",
    needs: "none",
    safety: "instant",
    icon: CursorText,
    keywords: ["focus", "composer", "type"],
    run: (context) => jumpToWorkAndFocus(context),
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.chatInsertPrompt,
    title: "Insert a prompt",
    hint: "Writes saved text at the caret in the active chat.",
    group: "Chat",
    kind: "write",
    needs: "chat",
    safety: "instant",
    icon: ChatCircle,
    keywords: ["text", "draft", "template"],
    enabled: IN_CHAT,
    run: (context, args) => {
      const text = args?.text?.trim();
      if (!text || !context.composer) return;
      context.composer.insertText(text);
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.chatStopTurn,
    title: "Stop the running turn",
    hint: "The composer's own Stop action.",
    group: "Chat",
    kind: "run",
    needs: "chat",
    safety: "instant",
    icon: Stop,
    keywords: ["interrupt", "cancel", "halt"],
    enabled: (context) => {
      if (!context.composer) return { ok: false, reason: "Open a chat first" };
      return context.composer.getSnapshot().turnActive
        ? { ok: true }
        : { ok: false, reason: "No turn is running" };
    },
    run: (context) => {
      context.composer?.stopTurn();
    },
  },

  // ── Model ───────────────────────────────────────────────────────────────
  {
    id: QUICK_SLOT_COMMAND_IDS.modelOpenPicker,
    title: "Model picker",
    group: "Model",
    kind: "set",
    needs: "chat",
    safety: "instant",
    icon: Brain,
    keywords: ["model", "choose", "switch"],
    enabled: (context) => {
      if (!context.composer) return { ok: false, reason: "Open a chat first" };
      return context.composer.getSnapshot().modelLocked
        ? { ok: false, reason: "Wait for this turn to end" }
        : { ok: true };
    },
    run: (context) => context.composer?.openModelPicker(),
  },
  thinkingCommand(1),
  thinkingCommand(-1),
  {
    id: QUICK_SLOT_COMMAND_IDS.modelCyclePermission,
    title: "Permission mode up",
    hint: "One rung up this harness's own permission list.",
    group: "Model",
    kind: "set",
    needs: "chat",
    safety: "instant",
    icon: Command,
    keywords: ["permission", "approval", "autonomy", "auto"],
    enabled: (context) => {
      if (!context.composer) return { ok: false, reason: "Open a chat first" };
      return context.composer.getSnapshot().permissionLocked
        ? { ok: false, reason: "Permission is locked for this chat" }
        : { ok: true };
    },
    run: (context) => {
      const result = context.composer?.cyclePermission();
      if (!result) {
        toast("This harness has no permission cycle", "Use the composer's own control for this provider.", "warning");
        return;
      }
      if (result.from === result.to) {
        toast(`Already at ${result.to}`, "This harness's highest permission mode is selected.", "info");
        return;
      }
      const dangerous = /bypass|full-auto|allowAll|danger-full-access|auto-high|agi|yolo|force/i.test(result.to);
      toast(
        `Permission: ${result.to}`,
        dangerous ? "This allows work without asking. Undo from the composer control." : "Applies to your next message.",
        dangerous ? "warning" : "info",
      );
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.modelToggleFast,
    title: "Fast mode",
    group: "Model",
    kind: "set",
    needs: "chat",
    safety: "instant",
    icon: CloudArrowUp,
    keywords: ["fast", "speed", "ultrafast", "service tier"],
    enabled: (context) => {
      if (!context.composer) return { ok: false, reason: "Open a chat first" };
      return context.composer.getSnapshot().modelLocked
        ? { ok: false, reason: "Wait for this turn to end" }
        : { ok: true };
    },
    run: (context) => {
      const composer = context.composer;
      if (!composer) return;
      const wasOn = composer.getSnapshot().fastMode;
      const ok = composer.toggleFast();
      if (!ok) {
        toast("This model has no fast tier", "Fast needs a model that advertises one.", "warning");
        return;
      }
      toast(`Fast mode ${wasOn ? "off" : "on"}`, "Applies to your next message.");
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.modelSaveProfile,
    title: "Save this chat's model as a profile",
    hint: "Then assign the profile to a slot.",
    group: "Model",
    kind: "set",
    needs: "chat",
    safety: "instant",
    icon: Brain,
    keywords: ["profile", "preset", "save", "model"],
    enabled: IN_CHAT,
    run: async (context) => {
      const composer = context.composer;
      if (!composer) return;
      const snapshot = composer.getSnapshot();
      if (!snapshot.modelId) {
        toast("No model to save", "Pick a model in the composer first.", "warning");
        return;
      }
      const name = await promptDialog({
        title: "Save model profile",
        message: "Name this model and thinking level. The current chat's permission mode is not saved.",
        defaultValue: "Fast",
        confirmLabel: "Save profile",
        placeholder: "Profile name",
      });
      if (!name?.trim()) return;
      useQuickSlotsStore.getState().upsertProfile({
        id: newModelProfileId(),
        name: name.trim(),
        modelId: snapshot.modelId,
        reasoningEffort: snapshot.reasoningEffort,
      });
      toast("Profile saved", "Assign it to a quick slot in Settings › Keyboard.", "success");
    },
  },

  // ── Lane ────────────────────────────────────────────────────────────────
  {
    id: QUICK_SLOT_COMMAND_IDS.laneOpenPr,
    title: "Open this lane's PR",
    hint: "Opens the PR when one exists; otherwise opens Create PR.",
    group: "Lane",
    kind: "go",
    needs: "lane",
    safety: "instant",
    icon: GithubLogo,
    keywords: ["pull request", "github", "review"],
    enabled: WITH_LANE,
    run: async (context) => {
      const lane = context.lane;
      if (!lane) return;
      const state = useAppStore.getState();
      const projectRoot = selectActiveProjectRoot(state);
      if (!projectRoot) {
        toast("Open a project first", undefined, "warning");
        return;
      }
      try {
        const [prs, snapshot] = await Promise.all([
          listPrsCoalesced({ projectRoot, pin: state.projectBinding }),
          getGitHubSnapshotCoalesced({}, { projectRoot }),
        ]);
        const tag = selectLaneTabPrTag(lane, prs, snapshot?.repoPullRequests ?? []);
        const route = tag ? lanePrTagRoutePath(tag) : null;
        if (route) {
          context.navigate(route);
          return;
        }
        context.navigate(`/prs?${new URLSearchParams({
          create: "1",
          sourceLaneId: lane.id,
        }).toString()}`);
      } catch (error) {
        toast("Could not read this lane's PR", errorText(error), "error");
      }
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.laneCreatePr,
    title: "Create a PR for this lane",
    hint: "Opens the PR form with this lane as the source.",
    group: "Lane",
    kind: "go",
    needs: "lane",
    safety: "surface",
    icon: ArrowSquareOut,
    keywords: ["pull request", "github", "ship"],
    enabled: WITH_LANE,
    run: (context) => {
      const lane = context.lane;
      if (!lane) return;
      context.navigate(`/prs?${new URLSearchParams({
        create: "1",
        sourceLaneId: lane.id,
      }).toString()}`);
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.laneCopyBranch,
    title: "Copy the branch name",
    group: "Lane",
    kind: "run",
    needs: "lane",
    safety: "instant",
    icon: Copy,
    keywords: ["clipboard", "branch", "git"],
    enabled: (context) => {
      if (!context.lane) return { ok: false, reason: "Select a lane first" };
      return context.lane.branchRef.trim()
        ? { ok: true }
        : { ok: false, reason: "This lane has no branch name" };
    },
    run: async (context) => {
      const branch = context.lane?.branchRef.trim();
      if (!branch) return;
      try {
        await navigator.clipboard.writeText(branch);
        toast("Branch copied", branch, "success");
      } catch (error) {
        toast("Could not copy the branch", errorText(error), "error");
      }
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.lanePush,
    title: "Push this lane",
    hint: "A plain push. Divergence and force-with-lease confirm first.",
    group: "Lane",
    kind: "run",
    needs: "lane",
    safety: "confirm",
    icon: CloudArrowUp,
    keywords: ["git", "push", "remote"],
    enabled: (context) => {
      if (!context.lane) return { ok: false, reason: "Select a lane first" };
      return context.lane.archivedAt ? { ok: false, reason: "This lane is archived" } : { ok: true };
    },
    run: async (context) => {
      const lane = context.lane;
      if (!lane) return;
      const state = useAppStore.getState();
      const toastId = "quick-slot-lane-push";
      showToast({ id: toastId, title: `Pushing ${lane.branchRef || lane.name}…`, durationMs: 0 });
      try {
        await window.ade.git.push({ laneId: lane.id }, state.projectBinding);
        showToast({ id: toastId, title: "Pushed", message: lane.branchRef || lane.name, tone: "success" });
      } catch (error) {
        showToast({
          id: toastId,
          title: "Push failed",
          message: `${errorText(error)} Use the lane's Git pane if the branch has diverged.`,
          tone: "error",
        });
      }
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.laneOpenWorktree,
    title: "Open the lane's worktree",
    hint: "Reveals it in the OS file manager on the machine that owns it.",
    group: "Lane",
    kind: "go",
    needs: "lane",
    safety: "instant",
    icon: Files,
    keywords: ["finder", "explorer", "folder", "worktree"],
    enabled: (context) => {
      if (!context.lane) return { ok: false, reason: "Select a lane first" };
      return context.lane.worktreePath?.trim()
        ? { ok: true }
        : { ok: false, reason: "This lane has no worktree" };
    },
    run: async (context) => {
      const lane = context.lane;
      if (!lane) return;
      try {
        await window.ade.lanes.revealWorktree({ laneId: lane.id });
      } catch (error) {
        toast("Could not open the worktree", errorText(error), "error");
      }
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.laneRebase,
    title: "Rebase this lane…",
    hint: "Opens the lane's own rebase controls; the scope is chosen there.",
    group: "Lane",
    kind: "go",
    needs: "lane",
    safety: "surface",
    icon: GitBranch,
    keywords: ["rebase", "sync", "main"],
    enabled: WITH_LANE,
    run: (context) => {
      const lane = context.lane;
      if (!lane) return;
      context.navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
    },
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.laneCreate,
    title: "Create a lane",
    hint: "Opens Lanes, where the name, base and machine are chosen.",
    group: "Lane",
    kind: "go",
    needs: "none",
    safety: "surface",
    icon: GitBranch,
    keywords: ["new", "worktree", "branch"],
    enabled: WITH_PROJECT,
    run: (context) => context.navigate("/lanes"),
  },

  // ── Tools ───────────────────────────────────────────────────────────────
  toolCommand("terminal", "Terminal", Terminal, "lane"),
  toolCommand("browser", "Browser", Globe, "none"),
  toolCommand("git", "Git", GitBranch, "lane"),
  toolCommand("pr", "Pull requests", GithubLogo, "lane"),
  toolCommand("issues", "Issues", Ticket, "none"),
  toolCommand("files", "Files", Files, "lane"),
  toolCommand("ios", "iOS simulator", AppleLogo, "lane"),
  toolCommand("app-control", "App Control", Monitor, "lane"),
  toolCommand("mac-desktop", "Mac Desktop", Desktop, "lane"),
  toolCommand("windows-desktop", "Windows Desktop", WindowsLogo, "lane"),

  // ── Navigate ────────────────────────────────────────────────────────────
  {
    id: QUICK_SLOT_COMMAND_IDS.navWork,
    title: "Go to Work",
    group: "Navigate",
    kind: "go",
    needs: "none",
    safety: "instant",
    icon: ChatCircle,
    keywords: ["chats", "sessions", "work"],
    run: (context) => context.navigate("/work"),
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.navLanes,
    title: "Go to Lanes",
    group: "Navigate",
    kind: "go",
    needs: "none",
    safety: "instant",
    icon: GitBranch,
    keywords: ["worktrees", "branches"],
    enabled: WITH_PROJECT,
    run: (context) => context.navigate("/lanes"),
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.navFiles,
    title: "Go to Files",
    group: "Navigate",
    kind: "go",
    needs: "none",
    safety: "instant",
    icon: Files,
    keywords: ["editor", "code"],
    enabled: WITH_PROJECT,
    run: (context) => context.navigate("/files"),
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.navPrs,
    title: "Go to Pull requests",
    group: "Navigate",
    kind: "go",
    needs: "none",
    safety: "instant",
    icon: GithubLogo,
    keywords: ["prs", "github", "review"],
    enabled: WITH_PROJECT,
    run: (context) => context.navigate("/prs"),
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.navSettings,
    title: "Go to Settings",
    group: "Navigate",
    kind: "go",
    needs: "none",
    safety: "instant",
    icon: Gear,
    keywords: ["preferences", "config"],
    run: (context) => context.navigate("/settings"),
  },
  {
    id: QUICK_SLOT_COMMAND_IDS.navCommandPalette,
    title: "Command palette",
    group: "Navigate",
    kind: "go",
    needs: "none",
    safety: "instant",
    icon: Command,
    keywords: ["search", "everything", "cmd k"],
    run: (context) => {
      const binding = getEffectiveBinding(context.keybindings, "commandPalette.open", "Mod+K");
      // The palette owns no programmatic entry point; replaying its own chord
      // is the documented route to it (`lib/keybindings.ts`).
      window.setTimeout(() => fireBinding(binding), 0);
    },
  },
];

/** One row per saved profile, so a slot can point at a model setup. */
export function profileCommands(profiles: readonly ModelProfile[]): QuickSlotCommand[] {
  return profiles.map((profile) => ({
    id: QUICK_SLOT_COMMAND_IDS.modelApplyProfile,
    title: profile.name,
    hint: `${profile.modelId}${profile.reasoningEffort ? ` · ${profile.reasoningEffort}` : ""}`,
    group: "Model",
    kind: "set",
    needs: "chat",
    safety: "instant",
    icon: Brain,
    keywords: ["profile", "model", profile.modelId],
    args: { profileId: profile.id },
    enabled: IN_CHAT,
    run: runApplyProfile,
  }));
}

export function findQuickSlotCommand(
  commands: readonly QuickSlotCommand[],
  commandId: string | null,
  args?: QuickSlotArgs,
): QuickSlotCommand | null {
  if (!commandId) return null;
  const wanted = args?.profileId ?? null;
  return commands.find((command) =>
    command.id === commandId
    && (command.args?.profileId ?? null) === wanted) ?? null;
}

/** A stable identity for "this command with these arguments". */
export function quickSlotCommandKey(command: QuickSlotCommand): string {
  const profileId = command.args?.profileId;
  return profileId ? `${command.id}:${profileId}` : command.id;
}
