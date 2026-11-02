import React, { useMemo, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import {
  QUICK_SLOT_COMMAND_IDS,
  reasoningEffortLabel,
  quickSlotLeaderLabel,
  type QuickSlot,
} from "../../../shared/quickSlots";
import { confirmDialog, Dialog, promptDialog } from "../ui/dialog";
import { SettingsSelect, SettingsTextField, SettingsToggle } from "./primitives/SettingsControls";
import { ModernRow, ModernRows, ModernSection } from "./primitives/SettingsModern";
import { isMacPlatform, isWindowsPlatform } from "../../lib/platform";
import { getEffectiveBinding } from "../../lib/keybindings";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { KEYBINDING_DEFINITIONS, WEB_KEYBINDING_DEFINITIONS } from "../../../shared/keybindings";
import { quickSlotChordConflict, resolveBindingChords } from "../../../shared/keybindingEditor";
import {
  QUICK_SLOT_COMMANDS,
  profileCommands,
  quickSlotCommandKey,
  type QuickSlotCommand,
} from "../../quickSlots/commands";
import { newModelProfileId, useQuickSlotsStore } from "../../quickSlots/quickSlotsStore";
import "../../quickSlots/quickSlots.css";

const GROUP_ORDER: QuickSlotCommand["group"][] = ["Chat", "Model", "Lane", "Tools", "Navigate"];

function matches(command: QuickSlotCommand, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    command.title,
    command.hint ?? "",
    command.group,
    ...(command.keywords ?? []),
  ].some((value) => value.toLowerCase().includes(needle));
}

function slotCommand(
  slot: QuickSlot,
  commands: readonly QuickSlotCommand[],
): QuickSlotCommand | null {
  if (!slot.commandId) return null;
  return commands.find((command) =>
    command.id === slot.commandId
    && (command.args?.profileId ?? null) === (slot.args?.profileId ?? null)) ?? null;
}

const QUICK_SLOT_GROUP_DETAIL: Record<QuickSlotCommand["group"], string> = {
  Chat: "Acts on the chat in front of you.",
  Model: "Changes the chat's model settings.",
  Lane: "Acts on the lane in front of you.",
  Tools: "Opens this tool in the Work tools pane.",
  Navigate: "Opens this page or panel.",
};

export function QuickSlotsSection() {
  const {
    slots,
    profiles,
    leader,
    keepOpenAfterRelease,
    profileCaretBehavior,
    setSlot,
    setLeader,
    setKeepOpenAfterRelease,
    setProfileCaretBehavior,
    resetSlots,
    removeProfile,
    upsertProfile,
  } = useQuickSlotsStore();
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [addProfileOpen, setAddProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileModel, setProfileModel] = useState("");
  const [profileEffort, setProfileEffort] = useState("default");

  const commands = useMemo(
    () => [...QUICK_SLOT_COMMANDS, ...profileCommands(profiles)],
    [profiles],
  );
  const mac = isMacPlatform();
  const keybindings = useAppStore((state) => state.keybindings);
  // Shortcuts a slot chord would shadow: Quick slots read the leader first.
  const shadowed = useMemo(() => {
    const platform = mac ? "mac" as const : isWindowsPlatform() ? "windows" as const : "linux" as const;
    const definitions = isWebClientMode() ? WEB_KEYBINDING_DEFINITIONS : KEYBINDING_DEFINITIONS;
    const out: string[] = [];
    for (const definition of definitions) {
      const binding = getEffectiveBinding(keybindings, definition.id, definition.defaultBinding);
      for (const chord of resolveBindingChords(binding, platform)) {
        const slot = quickSlotChordConflict(chord, leader, platform);
        if (slot) out.push(`slot ${slot} hides “${definition.description}”`);
      }
    }
    return out;
  }, [keybindings, leader, mac]);

  const grouped = useMemo(() => {
    const visible = commands.filter((command) => matches(command, query));
    return GROUP_ORDER
      .map((group) => ({ group, rows: visible.filter((command) => command.group === group) }))
      .filter((entry) => entry.rows.length > 0);
  }, [commands, query]);

  const choose = async (command: QuickSlotCommand | null) => {
    if (pickerSlot == null) return;
    if (!command) {
      setSlot(pickerSlot, null);
      setPickerSlot(null);
      setQuery("");
      return;
    }
    let args = command.args;
    let label = command.title;
    if (command.id === QUICK_SLOT_COMMAND_IDS.chatInsertPrompt) {
      const text = await promptDialog({
        title: "Prompt text",
        message: "This text is inserted at the caret in the active chat.",
        confirmLabel: "Save text",
        placeholder: "Review the diff and fix the failing test",
      });
      if (!text?.trim()) return;
      const trimmed = text.trim();
      args = { text: trimmed };
      label = `Insert: ${trimmed.slice(0, 28)}${trimmed.length > 28 ? "…" : ""}`;
    }
    setSlot(pickerSlot, command.id, args, label);
    setPickerSlot(null);
    setQuery("");
  };

  const leaderOptions = mac
    ? [
        { value: "default" as const, label: quickSlotLeaderLabel("default", true) },
        { value: "alternate" as const, label: quickSlotLeaderLabel("alternate", true) },
      ]
    : [{ value: "default" as const, label: "Ctrl+Shift" }];

  return (
    <>
      <ModernSection
        group="Quick slots"
        anchor="quick-slots"
        title="Quick slots"
        hint={
          <>
            Hold <kbd className="kit-kbd" data-size="sm">{quickSlotLeaderLabel(leader, mac)}</kbd> and tap 1–9 to run
            a slot on the chat, lane or tool in front of you.
          </>
        }
        actions={
          <button
            type="button"
            className="kit-btn kit-btn-ghost"
            data-size="sm"
            onClick={async () => {
              const ok = await confirmDialog({
                title: "Reset all nine slots?",
                message: "Your saved model profiles stay. The slot assignments go back to the shipped defaults.",
                confirmLabel: "Reset slots",
              });
              if (ok) resetSlots();
            }}
          >
            Reset
          </button>
        }
      >
        <div className="ade-ap-grid3 ade-qs-slots">
          {slots.map((slot) => {
            const command = slotCommand(slot, commands);
            const label = slot.commandId
              ? (command
                ? (command.id === QUICK_SLOT_COMMAND_IDS.chatInsertPrompt
                  ? (slot.label ?? command.title)
                  : command.title)
                : (slot.label ?? "Action unavailable"))
              : "Empty";
            // A command without a hint still names its group; only a slot whose
            // command is gone asks for another action.
            const detail = command
              ? (command.hint ?? QUICK_SLOT_GROUP_DETAIL[command.group])
              : (slot.commandId ? "Action unavailable. Pick another." : "Click to assign");
            return (
              <button
                key={slot.index}
                type="button"
                className="ade-ap-choice ade-qs-slot"
                data-empty={!slot.commandId || undefined}
                onClick={() => {
                  setPickerSlot(slot.index);
                  setQuery("");
                }}
              >
                <span className="kit-num ade-qs-slot-num">{slot.index}</span>
                <span className="ade-qs-slot-label">{label}</span>
                <span className="ade-qs-slot-detail">{detail}</span>
              </button>
            );
          })}
        </div>

        <ModernRows>
          <ModernRow
            title="Leader keys"
            hint={shadowed.length
              ? `With these keys, ${shadowed.join("; ")}. Change the leader or that shortcut.`
              : mac ? "Option+Command is the default. Slot 8 can collide with macOS Zoom when zoom is on." : "Ctrl+Shift keeps Ctrl+Alt (AltGr) free."}
            control={
              <SettingsSelect
                value={leader}
                options={leaderOptions}
                onChange={setLeader}
                ariaLabel="Quick slots leader keys"
              />
            }
          />
          <ModernRow
            title="Keep the panel open"
            hint="Release the keys without choosing. Useful when holding two modifiers is hard."
            control={
              <SettingsToggle
                checked={keepOpenAfterRelease}
                onChange={setKeepOpenAfterRelease}
                label="Keep quick slots open after release"
              />
            }
          />
          <ModernRow
            title="A model profile with the caret in the prompt"
            hint="The other case always sets this chat's model. A mention names the model in the instruction instead."
            control={
              <SettingsSelect
                value={profileCaretBehavior}
                options={[
                  { value: "insert" as const, label: "Insert a mention" },
                  { value: "set" as const, label: "Set this chat" },
                ]}
                onChange={setProfileCaretBehavior}
                ariaLabel="Model profile behavior in the prompt"
              />
            }
          />
        </ModernRows>

      </ModernSection>

      <ModernSection
        group="Model profiles"
        anchor="model-profiles"
        title="Model profiles"
        hint="A model and a thinking level. Permissions stay in the composer."
        actions={
          <button type="button" className="kit-btn" data-size="sm" onClick={() => setAddProfileOpen(true)}>
            <Plus size={12} /> Add profile
          </button>
        }
      >
        {profiles.length === 0 ? (
          <p className="ade-qs-empty">
            No profiles yet. Save one from a chat with the “Save this chat's model as a profile” slot, or add one by model id.
          </p>
        ) : (
          <ModernRows>
            {profiles.map((profile) => (
              <ModernRow
                key={profile.id}
                title={profile.name}
                hint={`${profile.modelId} · ${reasoningEffortLabel(profile.reasoningEffort)}`}
                control={(
                  <button
                    type="button"
                    className="kit-icon-btn"
                    aria-label={`Delete profile ${profile.name}`}
                    title="Delete profile"
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: `Delete ${profile.name}?`,
                        message: "Slots using this profile become empty.",
                        confirmLabel: "Delete",
                        destructive: true,
                      });
                      if (ok) removeProfile(profile.id);
                    }}
                  >
                    <Trash size={13} />
                  </button>
                )}
              />
            ))}
          </ModernRows>
        )}
      </ModernSection>

      <Dialog
        open={pickerSlot != null}
        onOpenChange={(open) => {
          if (!open) {
            setPickerSlot(null);
            setQuery("");
          }
        }}
        title={`Slot ${pickerSlot ?? ""}`}
        description="Pick one action. Empty slots go back to the dashed state."
        size="md"
      >
        <div className="ade-qs-picker">
          <input
            className="kit-input ade-qs-picker-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions"
            aria-label="Search actions"
            autoFocus
          />
          <div className="ade-qs-picker-list">
            <button type="button" className="ade-qs-picker-row" onClick={() => choose(null)}>
              <span className="ade-qs-picker-title">Empty slot</span>
              <span className="ade-qs-picker-hint">Leave this slot unassigned</span>
            </button>
            {grouped.map(({ group, rows }) => (
              <React.Fragment key={group}>
                <div className="ade-qs-picker-group">{group}</div>
                {rows.map((command) => {
                  const Icon = command.icon;
                  return (
                    <button
                      key={quickSlotCommandKey(command)}
                      type="button"
                      className="ade-qs-picker-row"
                      onClick={() => choose(command)}
                    >
                      <Icon size={15} weight="duotone" />
                      <span className="ade-qs-picker-text">
                        <span className="ade-qs-picker-title">{command.title}</span>
                        <span className="ade-qs-picker-hint">{command.hint ?? command.title}</span>
                      </span>
                      <span className="ade-qs-picker-kind">{command.kind.toUpperCase()}</span>
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
            {grouped.length === 0 ? (
              <p className="ade-qs-empty">No action matches “{query.trim()}”.</p>
            ) : null}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={addProfileOpen}
        onOpenChange={setAddProfileOpen}
        title="Add a model profile"
        description="The faster path is to save the active chat's model from ⌘K. This form is for a model you know by id."
      >
        <div className="ade-qs-profile-form">
          <label className="ade-qs-form-label">
            Name
            <SettingsTextField value={profileName} onChange={setProfileName} placeholder="Fast" />
          </label>
          <label className="ade-qs-form-label">
            Model id
            <SettingsTextField
              value={profileModel}
              onChange={setProfileModel}
              placeholder="anthropic/claude-opus-5"
              mono
            />
          </label>
          <label className="ade-qs-form-label">
            Thinking
            <SettingsSelect
              value={profileEffort}
              options={[
                { value: "default", label: "Default" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
                { value: "max", label: "Max" },
              ]}
              onChange={setProfileEffort}
              ariaLabel="Profile thinking level"
            />
          </label>
          <div className="ade-qs-form-actions">
            <button
              type="button"
              className="kit-btn kit-btn-primary"
              data-size="sm"
              disabled={!profileName.trim() || !profileModel.trim()}
              onClick={() => {
                upsertProfile({
                  id: newModelProfileId(),
                  name: profileName,
                  modelId: profileModel,
                  reasoningEffort: profileEffort === "default" ? null : profileEffort,
                });
                setAddProfileOpen(false);
                setProfileName("");
                setProfileModel("");
                setProfileEffort("default");
              }}
            >
              Save profile
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
