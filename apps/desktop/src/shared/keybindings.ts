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
  }
];

