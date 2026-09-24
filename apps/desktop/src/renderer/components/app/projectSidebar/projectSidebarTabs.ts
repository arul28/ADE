import type React from "react";
import {
  Clock,
  FileCode,
  GitBranch,
  GitPullRequest,
  HourglassSimple,
  Robot,
  Terminal,
} from "@phosphor-icons/react";
import type { KeybindingsSnapshot } from "../../../../shared/types";
import { getEffectiveBinding } from "../../../lib/keybindings";
import { isMac } from "../../../lib/platform";
import { isWebClientMode, WEB_CLIENT_TAB_PATHS } from "../../../lib/webClientMode";
import { readStoredPrsRoute } from "../../prs/prsRouteState";

export type ProjectSidebarTab = {
  to: string;
  label: string;
  icon: React.ElementType;
  /** Keybinding id and default chord, when the tab has a shortcut. */
  keybinding?: { id: string; fallback: string };
};

export const PROJECT_SIDEBAR_TABS: ProjectSidebarTab[] = [
  { to: "/work", label: "Work", icon: Terminal, keybinding: { id: "shell.tab.work", fallback: "Mod+1" } },
  { to: "/lanes", label: "Lanes", icon: GitBranch, keybinding: { id: "shell.tab.lanes", fallback: "Mod+2" } },
  { to: "/files", label: "Files", icon: FileCode, keybinding: { id: "shell.tab.files", fallback: "Mod+3" } },
  { to: "/prs", label: "PRs", icon: GitPullRequest, keybinding: { id: "shell.tab.prs", fallback: "Mod+4" } },
  {
    to: "/automations",
    label: "Automations",
    icon: Clock,
    keybinding: { id: "shell.tab.automations", fallback: "Mod+5" },
  },
];

export const PROJECT_SIDEBAR_FOOTER_TABS: ProjectSidebarTab[] = [
  { to: "/cto", label: "CTO", icon: Robot },
  { to: "/history", label: "History", icon: HourglassSimple },
];

export const PROJECT_SIDEBAR_TOGGLE_KEYBINDING = { id: "shell.sidebar.toggle", fallback: "Mod+B" };

/** The tab whose path owns `pathname`, e.g. `/prs/123` belongs to `/prs`. */
export function projectSidebarTabForPath(pathname: string): string | null {
  const all = [...PROJECT_SIDEBAR_TABS, ...PROJECT_SIDEBAR_FOOTER_TABS];
  const match = all.find((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`));
  return match?.to ?? null;
}

/** The hosted web client only surfaces the tabs in `WEB_CLIENT_TAB_PATHS`. */
export function visibleProjectSidebarTabs(tabs: ProjectSidebarTab[]): ProjectSidebarTab[] {
  if (!isWebClientMode()) return tabs;
  return tabs.filter((tab) => WEB_CLIENT_TAB_PATHS.has(tab.to));
}

/** Where a tab opens. PRs reopens the last PR route of this project. */
export function projectSidebarTabTarget(to: string, projectRoot: string | null): string {
  if (to === "/prs") return readStoredPrsRoute(projectRoot) ?? to;
  return to;
}

/**
 * A chord as a menu shows it: `⌘B` on macOS, `Ctrl+B` elsewhere. Only the first
 * alternative of a binding is shown.
 */
export function formatKeybindingLabel(binding: string): string {
  const first = binding.split(",")[0]?.trim() ?? "";
  const parts = first.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const labels = parts.map((part) => {
    const token = part.toLowerCase();
    if (token === "mod") return isMac ? "⌘" : "Ctrl";
    if (token === "cmd" || token === "meta" || token === "command") return isMac ? "⌘" : "Win";
    if (token === "ctrl" || token === "control") return isMac ? "⌃" : "Ctrl";
    if (token === "alt" || token === "option") return isMac ? "⌥" : "Alt";
    if (token === "shift") return isMac ? "⇧" : "Shift";
    return part.length === 1 ? part.toUpperCase() : part;
  });
  return isMac ? labels.join("") : labels.join("+");
}

export function projectSidebarShortcutLabel(
  keybindings: KeybindingsSnapshot | null,
  keybinding: { id: string; fallback: string } | undefined,
): string | null {
  if (!keybinding) return null;
  return formatKeybindingLabel(getEffectiveBinding(keybindings, keybinding.id, keybinding.fallback)) || null;
}
