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
import { isMacPlatform } from "../../lib/platform";
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
        { value: "default" as const, label: `Option+Command (${quickSlotLeaderLabel("default", true)})` },
        { value: "alternate" as const, label: `Control+Option (${quickSlotLeaderLabel("alternate", true)})` },
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
            Hold <kbd className="ade-qs-kbd">{quickSlotLeaderLabel(leader, mac)}</kbd> and tap
            1–9. Each slot runs one action on whatever chat, lane or tool is in front of you.
          </>
        }
      >
        <div className="ade-qs-settings-grid">
          {slots.map((slot) => {
            const command = slotCommand(slot, commands);
            const label = slot.commandId
              ? (command
                ? (command.id === QUICK_SLOT_COMMAND_IDS.chatInsertPrompt
                  ? (slot.label ?? command.title)
                  : command.title)
                : (slot.label ?? "Action unavailable"))
              : "Empty";
            const detail = command?.hint ?? (slot.commandId ? "Pick another action" : "Click to assign");
            return (
              <button
                key={slot.index}
                type="button"
                className="ade-qs-settings-cell"
                data-empty={!slot.commandId || undefined}
                onClick={() => {
                  setPickerSlot(slot.index);
                  setQuery("");
                }}
              >
                <span className="ade-qs-settings-num">{slot.index}</span>
                <span className="ade-qs-settings-label">{label}</span>
                <span className="ade-qs-settings-detail">{detail}</span>
              </button>
            );
          })}
        </div>

        <ModernRows>
          <ModernRow
            title="Leader keys"
            hint={mac ? "Option+Command is the default. Slot 8 can collide with macOS Zoom when zoom is on." : "Ctrl+Shift keeps Ctrl+Alt (AltGr) free."}
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

        <div className="ade-qs-settings-foot">
          <button
            type="button"
            className="ade-qs-settings-link"
            onClick={async () => {
              const ok = await confirmDialog({
                title: "Reset all nine slots?",
                message: "Your saved model profiles stay. The slot assignments go back to the shipped defaults.",
                confirmLabel: "Reset slots",
              });
              if (ok) resetSlots();
            }}
          >
            Reset slots to defaults
          </button>
        </div>
      </ModernSection>

      <ModernSection
        group="Model profiles"
        anchor="model-profiles"
        title="Model profiles"
        hint="A profile is a model plus a thinking level. It is not a permission mode: the chat's own permission stays in the composer."
        actions={
          <button type="button" className="ade-qs-settings-add" onClick={() => setAddProfileOpen(true)}>
            <Plus size={13} /> Add profile
          </button>
        }
      >
        {profiles.length === 0 ? (
          <p className="ade-qs-settings-empty">
            No profiles yet. Open a chat, set the model and thinking level you want, then assign
            “Save this chat's model as a profile” to a slot. Or add one by model id below.
          </p>
        ) : (
          <div className="ade-qs-profile-list">
            {profiles.map((profile) => (
              <div key={profile.id} className="ade-qs-profile-row">
                <div className="ade-qs-profile-main">
                  <span className="ade-qs-settings-label">{profile.name}</span>
                  <span className="ade-qs-settings-detail">
                    {profile.modelId} · {reasoningEffortLabel(profile.reasoningEffort)}
                  </span>
                </div>
                <button
                  type="button"
                  className="ade-qs-settings-icon"
                  aria-label={`Delete profile ${profile.name}`}
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
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
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
            className="ade-qs-picker-search"
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
              <p className="ade-qs-settings-empty">No action matches “{query.trim()}”.</p>
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
              className="ade-qs-settings-add"
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
