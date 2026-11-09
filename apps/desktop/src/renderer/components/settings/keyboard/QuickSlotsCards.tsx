import React, { useMemo, useState } from "react";
import { ArrowCounterClockwise, Cpu, Plus, SquaresFour, Trash } from "@phosphor-icons/react";
import {
  QUICK_SLOT_COMMAND_IDS,
  reasoningEffortLabel,
  quickSlotLeaderLabel,
  type QuickSlot,
} from "../../../../shared/quickSlots";
import type { KeybindingsSnapshot } from "../../../../shared/types";
import { resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { quickSlotChordConflict, resolveBindingChords, type KeyboardPlatform } from "../../../../shared/keybindingEditor";
import { modifierChordLabel } from "../../../lib/platform";
import { getEffectiveBinding } from "../../../lib/keybindings";
import {
  QUICK_SLOT_COMMANDS,
  profileCommands,
  quickSlotCommandKey,
  type QuickSlotCommand,
} from "../../../quickSlots/commands";
import { newModelProfileId, useQuickSlotsStore } from "../../../quickSlots/quickSlotsStore";
import { confirmDialog, Dialog, promptDialog } from "../../ui/dialog";
import { IntegrationCard } from "../integrations/IntegrationChrome";
import { SettingsSelect, SettingsTextField, SettingsToggle } from "../primitives/SettingsControls";
import { KeyCaps, leaderKeyCaps } from "./keyboardParts";
import "../../../quickSlots/quickSlots.css";

/** Every thinking level ADE knows, for a model id the registry does not. */
const PROFILE_EFFORT_FALLBACK: readonly string[] = ["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];

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

/** A settings row inside a card: title and hint on the left, the control on the right. */
function SettingRow({ title, hint, control, warn }: { title: React.ReactNode; hint?: React.ReactNode; control?: React.ReactNode; warn?: boolean }) {
  return (
    <div className="ade-kbp-setting">
      <div className="ade-kbp-setting-text">
        <b>{title}</b>
        {hint ? <small className={warn ? "ade-kbp-warn" : undefined}>{hint}</small> : null}
      </div>
      {control ? <div className="ade-kbp-setting-control">{control}</div> : null}
    </div>
  );
}

/** Settings › Keyboard › Quick slots and Model profiles. */
export function QuickSlotsCards({ snapshot, platform }: { snapshot: KeybindingsSnapshot; platform: KeyboardPlatform }) {
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
  // The thinking levels the typed model offers; every level ADE knows while the
  // id is not one the registry recognises. A level the model lacks never saves.
  const profileTiers = resolveModelDescriptor(profileModel)?.reasoningTiers;
  const profileEffortChoices = profileTiers ?? PROFILE_EFFORT_FALLBACK;
  const effectiveProfileEffort = profileEffortChoices.includes(profileEffort) ? profileEffort : "default";

  const commands = useMemo(
    () => [...QUICK_SLOT_COMMANDS, ...profileCommands(profiles)],
    [profiles],
  );
  const mac = platform === "mac";
  const leaderKeys = leaderKeyCaps(leader, platform);
  // Shortcuts a slot chord would shadow: Quick slots read the leader first.
  const shadowed = useMemo(() => {
    const out: string[] = [];
    for (const definition of snapshot.definitions) {
      const binding = getEffectiveBinding(snapshot, definition.id, definition.defaultBinding);
      for (const chord of resolveBindingChords(binding, platform)) {
        const slot = quickSlotChordConflict(chord, leader, platform);
        if (slot) out.push(`slot ${slot} hides “${definition.description}”`);
      }
    }
    return out;
  }, [snapshot, leader, platform]);

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
      <IntegrationCard
        anchor="quick-slots"
        icon={<SquaresFour size={16} weight="duotone" />}
        title="Quick slots"
        hint={<>Hold <KeyCaps keys={leaderKeys} /> and tap 1–9 to run a slot on the chat, lane or tool in front of you.</>}
        actions={(
          <button
            type="button"
            className="ade-modern-btn"
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
            <ArrowCounterClockwise size={12} />
            Reset
          </button>
        )}
      >
        <div className="ade-kbp-slots">
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
            const Icon = command?.icon ?? null;
            return (
              <button
                key={slot.index}
                type="button"
                className="ade-kbp-slot"
                data-empty={!slot.commandId || undefined}
                aria-label={`Slot ${slot.index}: ${label}. Change`}
                onClick={() => {
                  setPickerSlot(slot.index);
                  setQuery("");
                }}
              >
                <KeyCaps keys={[String(slot.index)]} />
                <span className="ade-kbp-slot-text">
                  <b>{label}</b>
                  <small>{detail}</small>
                </span>
                {Icon ? <Icon size={16} weight="duotone" className="ade-kbp-slot-icon" aria-hidden /> : null}
              </button>
            );
          })}
        </div>

        <div className="ade-ig-rows">
          <SettingRow
            title="Leader keys"
            hint={shadowed.length
              ? `With these keys, ${shadowed.join("; ")}. Change the leader or that shortcut.`
              : mac ? "Option+Command is the default. Slot 8 can collide with macOS Zoom when zoom is on." : "Ctrl+Shift keeps Ctrl+Alt (AltGr) free."}
            warn={shadowed.length > 0}
            control={
              <SettingsSelect
                value={leader}
                options={leaderOptions}
                onChange={setLeader}
                ariaLabel="Quick slots leader keys"
              />
            }
          />
          <SettingRow
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
          <SettingRow
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
        </div>
      </IntegrationCard>

      <IntegrationCard
        anchor="model-profiles"
        icon={<Cpu size={16} weight="duotone" />}
        title="Model profiles"
        hint="A model and a thinking level, for a Quick slot. Permissions stay in the composer."
        actions={(
          <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => setAddProfileOpen(true)}>
            <Plus size={12} />
            Add profile
          </button>
        )}
      >
        {profiles.length === 0 ? (
          <p className="ade-kbp-empty">
            No profiles yet. Save one from a chat with the “Save this chat's model as a profile” slot, or add one by model id.
          </p>
        ) : (
          <div className="ade-ig-rows">
            {profiles.map((profile) => (
              <SettingRow
                key={profile.id}
                title={profile.name}
                hint={<span className="kit-num">{profile.modelId} · {reasoningEffortLabel(profile.reasoningEffort)}</span>}
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
          </div>
        )}
      </IntegrationCard>

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
        description={`The faster path is to save the active chat's model from ${modifierChordLabel("K")}. This form is for a model you know by id.`}
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
              value={effectiveProfileEffort}
              options={[
                { value: "default", label: "Default" },
                ...profileEffortChoices.map((effort) => ({ value: effort, label: reasoningEffortLabel(effort) })),
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
                  reasoningEffort: effectiveProfileEffort === "default" ? null : effectiveProfileEffort,
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
