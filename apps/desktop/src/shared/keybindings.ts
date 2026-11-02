import type { KeybindingDefinition } from "./types";

/**
 * The override value that turns a shortcut off. The store keeps it like any
 * other binding; `getEffectiveBinding` reads it as "no keys", so a default can
 * be freed for another action without inventing a throwaway chord for it.
 */
export const KEYBINDING_UNASSIGNED = "none";

export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  {
    id: "commandPalette.open",
    description: "Open command palette",
    defaultBinding: "Mod+K",
    scope: "global"
  },
  {
    id: "shell.sidebar.toggle",
    description: "Show or hide the project sidebar",
    defaultBinding: "Mod+B",
    scope: "global"
  },
  {
    id: "shell.browser.open",
    description: "Open the Browser tab",
    defaultBinding: "Mod+Shift+B",
    scope: "global"
  },
  {
    id: "shell.music.open",
    description: "Open the Music tab",
    defaultBinding: "Mod+Shift+M",
    scope: "global"
  },
  {
    id: "shell.tab.work",
    description: "Open Work",
    defaultBinding: "Mod+1",
    scope: "global"
  },
  {
    id: "shell.tab.lanes",
    description: "Open Lanes",
    defaultBinding: "Mod+2",
    scope: "global"
  },
  {
    id: "shell.tab.files",
    description: "Open Files",
    defaultBinding: "Mod+3",
    scope: "global"
  },
  {
    id: "shell.tab.prs",
    description: "Open PRs",
    defaultBinding: "Mod+4",
    scope: "global"
  },
  {
    id: "shell.tab.automations",
    description: "Open Automations",
    defaultBinding: "Mod+5",
    scope: "global"
  },
  {
    id: "lanes.filter.focus",
    description: "Focus lanes filter",
    defaultBinding: "/,Mod+F",
    scope: "lanes"
  },
  {
    id: "lanes.select.next",
    description: "Select next lane",
    defaultBinding: "J,ArrowDown",
    scope: "lanes"
  },
  {
    id: "lanes.select.prev",
    description: "Select previous lane",
    defaultBinding: "K,ArrowUp",
    scope: "lanes"
  },
  {
    id: "lanes.select.nextTab",
    description: "Select next lane tab",
    defaultBinding: "]",
    scope: "lanes"
  },
  {
    id: "lanes.select.prevTab",
    description: "Select previous lane tab",
    defaultBinding: "[",
    scope: "lanes"
  },
  {
    id: "lanes.select.confirm",
    description: "Pin selected lane tab",
    defaultBinding: "Enter",
    scope: "lanes"
  },
  // Scope "work": the Work page's own actions. Every one is a modifier chord,
  // so the composer and the terminals keep their keys — see
  // `components/work/workShortcuts.ts` for the dispatcher and the rules.
  {
    id: "work.chat.next",
    description: "Next chat (wraps to the first)",
    defaultBinding: "Mod+ArrowDown",
    scope: "work"
  },
  {
    id: "work.chat.prev",
    description: "Previous chat (wraps to the last)",
    defaultBinding: "Mod+ArrowUp",
    scope: "work"
  },
  {
    id: "work.chat.focusComposer",
    description: "Jump into the prompt box",
    defaultBinding: "Mod+I",
    scope: "work"
  },
  {
    id: "work.chat.actions",
    description: "Chat actions and progress",
    defaultBinding: "Mod+Shift+A",
    scope: "work"
  },
  {
    id: "work.chat.new",
    description: "New chat",
    defaultBinding: "Mod+Shift+N",
    scope: "work"
  },
  {
    id: "work.tools.toggle",
    description: "Open or close the tools pane",
    defaultBinding: "Mod+T",
    scope: "work"
  },
  // Scope "global": the project tabs at the top of the window, reachable from
  // any page (Ctrl, not ⌘, because ⌘⇧] / ⌘⇧[ belong to the surfaces' own
  // lists and the browser's tab convention).
  {
    id: "project.tab.next",
    description: "Next project",
    defaultBinding: "Ctrl+Tab",
    scope: "global"
  },
  {
    id: "project.tab.prev",
    description: "Previous project",
    defaultBinding: "Ctrl+Shift+Tab",
    scope: "global"
  },
  // Scope "chat": the prompt box you last worked in (Work, a chat tile, a
  // personal chat), the same target Quick slots use. Letters with Shift, so
  // the keys survive a held Shift on every layout; none of them is a menu or
  // system chord on macOS, Windows or Linux.
  {
    id: "chat.effort.up",
    description: "Raise the thinking level",
    defaultBinding: "Mod+Shift+E",
    scope: "chat"
  },
  {
    id: "chat.effort.down",
    description: "Lower the thinking level",
    defaultBinding: "Mod+Shift+D",
    scope: "chat"
  },
  {
    id: "chat.fast.toggle",
    description: "Turn fast mode on or off",
    defaultBinding: "Mod+Shift+F",
    scope: "chat"
  },
  // Scope "terminal": answered by the terminal tool while focus is inside it.
  // Arrows, not brackets: Ctrl+[ is Escape in a terminal on Windows and Linux.
  {
    id: "terminal.next",
    description: "Next terminal (wraps to the first)",
    defaultBinding: "Mod+Shift+ArrowRight",
    scope: "terminal"
  },
  {
    id: "terminal.prev",
    description: "Previous terminal (wraps to the last)",
    defaultBinding: "Mod+Shift+ArrowLeft",
    scope: "terminal"
  },
  // Scope "home": handled by the home page while it is showing.
  {
    id: "home.layout.next",
    description: "Switch to the next saved home layout",
    defaultBinding: "Mod+Shift+L",
    scope: "home"
  },
  // Scope "work" means "handled inside the Work tools pane", not globally: the
  // pane attaches this to its own keydown handler. A global Escape binding would
  // fight the composer, every dialog, and the browser panel's own URL field.
  {
    id: "work.tools.picker",
    description: "Back to the Work tools picker",
    defaultBinding: "Escape",
    scope: "work"
  }
];


/**
 * Defaults for the hosted web client where a desktop default is a chord the
 * browser reserves: Chrome, Firefox and Safari keep ⌘T/Ctrl+T (new tab),
 * ⌘⇧N/Ctrl+Shift+N (new private window) and Ctrl+Tab/Ctrl+Shift+Tab (switch
 * tab) for themselves, so the page never sees them. None of these collide with
 * another binding above, and a user override still wins over either default.
 */
export const WEB_KEYBINDING_DEFAULTS: Readonly<Record<string, string>> = {
  "work.chat.new": "Mod+Shift+O",
  "work.tools.toggle": "Mod+J",
  "project.tab.next": "Ctrl+`",
  "project.tab.prev": "Ctrl+Shift+~",
};

/** The table the hosted web client advertises: desktop's, with the web defaults. */
export const WEB_KEYBINDING_DEFINITIONS: KeybindingDefinition[] = KEYBINDING_DEFINITIONS.map((definition) => {
  const webDefault = WEB_KEYBINDING_DEFAULTS[definition.id];
  return webDefault ? { ...definition, defaultBinding: webDefault } : definition;
});
