import { useMemo } from "react";
import type { KeybindingsSnapshot } from "../../../shared/types";
import { bindingChipLabel, getEffectiveBinding } from "../../lib/keybindings";
import { isMacPlatform } from "../../lib/platform";
import { Dialog } from "../ui/dialog";
import { useAppStore } from "../../state/appStore";

/**
 * `?` on the Work page: the chords, one row each, with the user's own bindings.
 *
 * Opened only when the keyboard is not in a typable field (`?` is a character
 * everywhere else), and generated from the same `shared/keybindings.ts` ids the
 * dispatcher reads — a shortcut cannot be listed without a handler behind it.
 * Kept to one comfortable column: label left, keys right, nothing to decode.
 */

type SheetRow = { id: string; label: string; detail?: string; chips: string[] };
type SheetGroup = { id: string; title: string; rows: SheetRow[] };

function chip(
  keybindings: KeybindingsSnapshot | null,
  id: string,
  fallback: string,
): string {
  return bindingChipLabel(getEffectiveBinding(keybindings, id, fallback)) ?? fallback;
}

export function buildWorkShortcutSheet(keybindings: KeybindingsSnapshot | null): SheetGroup[] {
  return [
    {
      id: "chats",
      title: "Chats",
      rows: [
        { id: "work.chat.prev", label: "Previous chat", chips: [chip(keybindings, "work.chat.prev", "Mod+ArrowUp")] },
        { id: "work.chat.next", label: "Next chat", chips: [chip(keybindings, "work.chat.next", "Mod+ArrowDown")] },
        { id: "work.chat.focusComposer", label: "Jump into the prompt box, or leave it", chips: [chip(keybindings, "work.chat.focusComposer", "Mod+I")] },
        { id: "work.chat.actions", label: "Chat actions and progress", chips: [chip(keybindings, "work.chat.actions", "Mod+Shift+A")] },
        { id: "work.chat.new", label: "New chat", chips: [chip(keybindings, "work.chat.new", "Mod+Shift+N")] },
      ],
    },
    {
      id: "panes",
      title: "Panes and projects",
      rows: [
        { id: "work.tools.toggle", label: "Open or close the tools pane", chips: [chip(keybindings, "work.tools.toggle", "Mod+T")] },
        { id: "work.tools.picker", label: "Back out of the tools pane", chips: [chip(keybindings, "work.tools.picker", "Escape")] },
        { id: "shell.sidebar.toggle", label: "Show or hide the sidebar", chips: [chip(keybindings, "shell.sidebar.toggle", "Mod+B")] },
        { id: "project.tab.next", label: "Next project tab", detail: "opens the picker with one project", chips: [chip(keybindings, "project.tab.next", "Ctrl+Tab")] },
        { id: "project.tab.prev", label: "Previous project tab", chips: [chip(keybindings, "project.tab.prev", "Ctrl+Shift+Tab")] },
      ],
    },
    {
      id: "everywhere",
      title: "Everywhere",
      rows: [
        { id: "commandPalette.open", label: "Search everything", chips: [chip(keybindings, "commandPalette.open", "Mod+K")] },
        {
          id: "shell.tabs",
          label: "Work, Lanes, Files, PRs, Automations",
          chips: [
            chip(keybindings, "shell.tab.work", "Mod+1"),
            chip(keybindings, "shell.tab.lanes", "Mod+2"),
            chip(keybindings, "shell.tab.files", "Mod+3"),
            chip(keybindings, "shell.tab.prs", "Mod+4"),
            chip(keybindings, "shell.tab.automations", "Mod+5"),
          ],
        },
      ],
    },
  ];
}

function KeyChip({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-[24px] min-w-[24px] items-center justify-center rounded-[7px] border border-fg/12 bg-fg/[0.05] px-2 text-[12.5px] font-semibold tracking-[0.01em] text-fg/90 shadow-[inset_0_-1px_0_rgba(0,0,0,0.28)]">
      {children}
    </kbd>
  );
}

/**
 * What the modifier glyphs mean, in words.
 *
 * `⌃` and `⇧` look alike at a glance and mean very different things ("next
 * project" vs "type a capital"), so the sheet spells them out once at the
 * bottom instead of leaving the reader to guess.
 */
function ModifierLegend() {
  if (!isMacPlatform()) return null;
  return (
    <p className="pt-1 text-[11px] leading-relaxed text-muted-fg/60">
      ⌃ Control · ⌥ Option · ⇧ Shift · ⌘ Command
    </p>
  );
}

export function WorkShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const keybindings = useAppStore((state) => state.keybindings);
  const groups = useMemo(() => buildWorkShortcutSheet(keybindings), [keybindings]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Shortcuts"
      description="The Work page. Press ? again — or Esc — to close this."
      size="md"
    >
      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.id}>
            <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-fg/70">
              {group.title}
            </h3>
            <ul>
              {group.rows.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-6 border-b border-fg/[0.06] py-[9px] text-[13.5px] last:border-b-0"
                >
                  <span className="min-w-0 text-fg/85">
                    {row.label}
                    {row.detail ? (
                      <span className="ml-2 text-[11.5px] text-muted-fg/60">{row.detail}</span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.chips.map((value) => <KeyChip key={`${row.id}-${value}`}>{value}</KeyChip>)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <ModifierLegend />
      </div>
    </Dialog>
  );
}
