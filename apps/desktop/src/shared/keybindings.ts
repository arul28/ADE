import type { KeybindingDefinition } from "./types";

export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  {
    id: "commandPalette.open",
    description: "Open command palette",
    defaultBinding: "Mod+K",
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

