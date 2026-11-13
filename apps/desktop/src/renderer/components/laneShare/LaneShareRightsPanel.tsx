import React from "react";
import { CaretDown, CaretRight, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { resolveModelDescriptor } from "../../../shared/modelRegistry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import {
  LANE_SHARE_PRESET_NAMES,
  LANE_SHARE_TOOL_DOMAINS,
  LANE_SHARE_TOOL_READS,
  laneShareLowRiskSummary,
  laneSharePresetLabel,
  laneSharePresetRights,
  laneShareRiskLevel,
  type LaneShareCliTyping,
  type LaneShareCliTypingUnavailableReason,
  type LaneSharePresetName,
  type LaneShareRights,
  type LaneShareToolDomain,
} from "../../../shared/laneShareRights";
import { AGENT_CHAT_PERMISSION_MODE_VALUES } from "../../../shared/types/chat";
import { SettingsToggle } from "../settings/primitives/SettingsControls";
import { ModernRow, ModernRows } from "../settings/primitives/SettingsModern";
import {
  LANE_SHARE_PRESET_LABELS,
  LANE_SHARE_RISK_LABELS,
  formatLaneShareEnd,
  laneShareQuickEnds,
  sameLaneShareRights,
} from "./laneShareModel";
import { LANE_SHARE_MODE_TITLES, LANE_SHARE_REASONING_TITLES } from "./laneShareUi";
import "./laneShare.css";

/**
 * The rights of one person. The everyday choices (how long, what of the
 * owner's computer shows) are always visible; every single switch is under
 * "All rights", in the groups See, Speak, Run, Decide, Tools and Limits.
 * Every control writes one field of `LaneShareRights`; the risk level and its
 * reasons come from `laneShareRiskLevel`, live.
 */

const TOOL_TITLES: Record<LaneShareToolDomain, string> = {
  file: "Files",
  git: "Git history",
  diff: "Changes",
  pr: "Pull request",
  terminal: "Terminals",
  built_in_browser: "Built-in browser",
  ios_simulator: "iOS simulator",
  mac_desktop: "Mac desktop",
  android_emulator: "Android emulator",
  app_control: "App control",
};

/** Why the lane's machine cannot offer "Type into CLI sessions", as the owner reads it. */
const CLI_TYPING_UNAVAILABLE_HINTS: Record<LaneShareCliTypingUnavailableReason, string> = {
  windows_host: "Not on a Windows computer: ADE cannot tell a CLI from the shell behind it there.",
};

/** The reasoning levels ADE's providers name. A saved level outside this list still shows. */
const REASONING_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Watch / Comment / Suggest / Collaborate as one segmented control. A rights
 * object that matches none reads as Custom (shown, not pickable).
 */
export function LaneSharePresetPicker({
  value,
  disabled,
  onChange,
  label = "Access level",
}: {
  value: LaneSharePresetName | "custom";
  disabled?: boolean;
  onChange: (preset: LaneSharePresetName) => void;
  label?: string;
}) {
  return (
    <div className="kit-seg ade-ls-preset" data-case="sentence" role="group" aria-label={label} data-testid="lane-share-preset">
      {LANE_SHARE_PRESET_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          aria-pressed={value === name}
          disabled={disabled}
          onClick={() => onChange(name)}
        >
          {LANE_SHARE_PRESET_LABELS[name]}
        </button>
      ))}
      {value === "custom" ? (
        <button type="button" aria-pressed disabled>
          Custom
        </button>
      ) : null}
    </div>
  );
}

/** The risk of a rights object as one line: a status dot, the level, and what it means in plain words. */
export function LaneShareRiskSummary({ rights }: { rights: LaneShareRights }) {
  const risk = laneShareRiskLevel(rights);
  const tone = risk.level === "high" ? "crit" : risk.level === "medium" ? "warn" : "ok";
  const detail = risk.reasons.length > 0 ? risk.reasons.join(" ") : laneShareLowRiskSummary(rights);
  return (
    <div className="ade-ls-risk" data-testid="lane-share-risk" data-level={risk.level} role="status">
      <span className="kit-dot" data-state={tone} aria-hidden />
      <div className="min-w-0">
        <span className="ade-ls-risk-level" data-tone={tone}>{LANE_SHARE_RISK_LABELS[risk.level]}</span>
        <span className="ade-ls-risk-detail">{detail}</span>
      </div>
    </div>
  );
}

/** A settings row whose control is one switch named by the row's title. */
function ToggleRow({ title, hint, checked, disabled, onChange }: {
  title: string;
  hint?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return <ModernRow title={title} hint={hint} control={<SettingsToggle label={title} checked={checked} onChange={onChange} disabled={disabled} />} />;
}

/** A multi-pick row of choices: each button toggles one value. */
function MultiPick<T extends string>({
  label,
  options,
  values,
  titles,
  disabled,
  onChange,
}: {
  label: string;
  options: readonly T[];
  values: readonly T[];
  titles: Record<string, string>;
  disabled?: boolean;
  onChange: (next: T[]) => void;
}) {
  const extra = values.filter((value) => !options.includes(value));
  return (
    <div className="kit-seg ade-ls-multipick" data-case="sentence" role="group" aria-label={label}>
      {[...options, ...extra].map((option) => {
        const on = values.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? values.filter((value) => value !== option) : [...values, option])}
          >
            {titles[option] ?? option}
          </button>
        );
      })}
    </div>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="ade-ls-group" data-testid={`lane-share-group-${id}`}>
      <h4 className="ade-ls-group-title">{title}</h4>
      <ModernRows>{children}</ModernRows>
    </section>
  );
}

function limitValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The models a guest may use: one quiet row per model with its remove
 * button, then ADE's own model picker to add one. Empty: the chat's model.
 */
function ModelAllowList({
  models,
  disabled,
  runtimePin,
  onChange,
}: {
  models: readonly string[];
  disabled?: boolean;
  runtimePin: OpenProjectBinding | null;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="ade-ls-models" data-testid="lane-share-models">
      {models.map((id) => (
        <div key={id} className="ade-ls-model">
          <span className="ade-ls-model-name" title={id}>{resolveModelDescriptor(id)?.displayName ?? id}</span>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label={`Remove ${resolveModelDescriptor(id)?.displayName ?? id}`}
            disabled={disabled}
            onClick={() => onChange(models.filter((value) => value !== id))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <ModelPicker
        value=""
        emptyLabel="Add a model"
        compact
        disabled={disabled}
        runtimePin={runtimePin}
        onChange={(modelId) => {
          if (modelId && !models.includes(modelId)) onChange([...models, modelId]);
        }}
      />
    </div>
  );
}

export function LaneShareRightsPanel({
  rights,
  endsAt,
  onChange,
  onEndsAtChange,
  disabled = false,
  now,
  cliTyping = null,
  showEnd = true,
  detailsOpen: detailsOpenInitial = false,
  folded = false,
  runtimePin = null,
}: {
  rights: LaneShareRights;
  endsAt: number | null;
  onChange: (next: LaneShareRights) => void;
  onEndsAtChange: (next: number | null) => void;
  disabled?: boolean;
  now: number;
  /**
   * Whether the machine of the shared lane lets a guest type into a CLI.
   * Not available: the switch stays off and says why. Null: no particular
   * machine (the saved defaults) or an older host.
   */
  cliTyping?: LaneShareCliTyping | null;
  /** The end date row (a share's own; the saved defaults have none). */
  showEnd?: boolean;
  /** Whether "All rights" starts open. */
  detailsOpen?: boolean;
  /**
   * Everything behind one "More options" fold, with a one-line summary: the
   * share window, where the access level above already says most of it.
   */
  folded?: boolean;
  /** The lane's machine, whose models the Models picker lists. Null: this window's machine (the saved defaults). */
  runtimePin?: OpenProjectBinding | null;
}) {
  const set = <G extends "see" | "speak" | "run" | "decide" | "privacy">(group: G, patch: Partial<LaneShareRights[G]>) =>
    onChange({ ...rights, [group]: { ...rights[group], ...patch } });
  const setLimits = (patch: Partial<LaneShareRights["limits"]>) => onChange({ ...rights, limits: { ...rights.limits, ...patch } });
  const [detailsOpen, setDetailsOpen] = React.useState(detailsOpenInitial);
  const quickEnds = laneShareQuickEnds(now);
  const [pickedEnd, setPickedEnd] = React.useState<{ key: string; at: number | null } | null>(null);
  const cliTypingOff = cliTyping?.available === false ? CLI_TYPING_UNAVAILABLE_HINTS[cliTyping.reason] : null;
  const canRun = rights.speak.send || rights.run.startChats || rights.run.startCliSessions;

  const summary = [
    showEnd ? formatLaneShareEnd(endsAt) : null,
    rights.privacy.hideMachines ? "machines hidden" : null,
    rights.privacy.hideModels ? "models hidden" : null,
  ].filter(Boolean).join(", ");
  const disclosure = (label: string, testId: string) => (
    <button
      type="button"
      className="ade-ls-disclosure"
      aria-expanded={detailsOpen}
      onClick={() => setDetailsOpen((open) => !open)}
      data-testid={testId}
    >
      {detailsOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
      {label}
      {folded && !detailsOpen && summary ? <span className="ade-ls-disclosure-hint">{summary}</span> : null}
    </button>
  );
  if (folded && !detailsOpen) {
    return <div className="ade-ls-rights" data-testid="lane-share-rights">{disclosure("More options", "lane-share-all-rights")}</div>;
  }

  return (
    <div className="ade-ls-rights" data-testid="lane-share-rights">
      {folded ? disclosure("More options", "lane-share-all-rights") : null}
      <ModernRows>
        {showEnd ? (
          <ModernRow
            title="Ends"
            hint={formatLaneShareEnd(endsAt)}
            control={(
              <div className="kit-seg" data-case="sentence" role="group" aria-label="Share end">
                {quickEnds.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    disabled={disabled}
                    // A quick end is relative to the click, so the picked one is remembered here.
                    aria-pressed={option.at == null ? endsAt == null : endsAt != null && pickedEnd?.key === option.key && pickedEnd.at === endsAt}
                    onClick={() => {
                      setPickedEnd({ key: option.key, at: option.at });
                      onEndsAtChange(option.at);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          />
        ) : null}
        <ToggleRow
          title="Hide my machines"
          hint="They see no machine name or kind." checked={rights.privacy.hideMachines} disabled={disabled} onChange={(hideMachines) => set("privacy", { hideMachines })} />
        <ToggleRow
          title="Hide my models"
          hint="They see only the models you allow." checked={rights.privacy.hideModels} disabled={disabled} onChange={(hideModels) => set("privacy", { hideModels })} />
      </ModernRows>

      {folded ? null : disclosure("All rights", "lane-share-all-rights")}

      {detailsOpen ? (
        <div className="ade-ls-groups">
          <Group id="see" title="What they see">
            <ToggleRow title="Chats" checked={rights.see.chats} disabled={disabled} onChange={(chats) => set("see", { chats })} />
            <ToggleRow title="Subagent chats" checked={rights.see.subagentChats} disabled={disabled} onChange={(subagentChats) => set("see", { subagentChats })} />
            <ToggleRow title="CLI sessions" checked={rights.see.cliSessions} disabled={disabled} onChange={(cliSessions) => set("see", { cliSessions })} />
            <ToggleRow title="Shells"
              hint="Always read only. A guest never types into or starts a shell." checked={rights.see.shells} disabled={disabled} onChange={(shells) => set("see", { shells })} />
            <ToggleRow title="History before the share"
              hint="Off: only what happens from now on." checked={rights.see.historyBeforeShare} disabled={disabled} onChange={(historyBeforeShare) => set("see", { historyBeforeShare })} />
          </Group>

          <Group id="speak" title="What they can say">
            <ToggleRow title="Comment on replies" checked={rights.speak.comment} disabled={disabled} onChange={(comment) => set("speak", { comment })} />
            <ToggleRow title="Write drafts" hint="Only you send a draft." checked={rights.speak.drafts} disabled={disabled} onChange={(drafts) => set("speak", { drafts })} />
            <ToggleRow title="Send messages" checked={rights.speak.send} disabled={disabled} onChange={(send) => set("speak", { send })} />
            <ToggleRow title="Steer their own turns" checked={rights.speak.steer} disabled={disabled} onChange={(steer) => set("speak", { steer })} />
            <ToggleRow title="Stop or steer any turn"
              hint="Yours and other guests' too." checked={rights.speak.interruptAnyTurn} disabled={disabled} onChange={(interruptAnyTurn) => set("speak", { interruptAnyTurn })} />
          </Group>

          <Group id="run" title="What they can start">
            <ToggleRow title="Start chats" checked={rights.run.startChats} disabled={disabled} onChange={(startChats) => set("run", { startChats })} />
            <ToggleRow title="Start CLI sessions" checked={rights.run.startCliSessions} disabled={disabled} onChange={(startCliSessions) => set("run", { startCliSessions })} />
            <ToggleRow
              title="Type into CLI sessions"
              hint={cliTypingOff ?? "The same reach as a shell."}
              checked={cliTypingOff ? false : rights.run.typeInCliSessions}
              disabled={disabled || cliTypingOff != null}
              onChange={(typeInCliSessions) => set("run", { typeInCliSessions })}
            />
            {canRun ? (
              <>
                <ModernRow title="Models" hint={rights.run.models.length === 0 ? "None picked: the chat's current model only, and no new chat or CLI session can start." : undefined}>
                  <ModelAllowList
                    models={rights.run.models}
                    disabled={disabled}
                    runtimePin={runtimePin}
                    onChange={(models) => set("run", { models })}
                  />
                </ModernRow>
                <ModernRow title="Reasoning levels" hint={rights.run.reasoningLevels.length === 0 ? "None picked: the chat's current level only." : undefined}>
                  <MultiPick
                    label="Reasoning levels a guest may pick"
                    options={REASONING_LEVELS}
                    values={rights.run.reasoningLevels}
                    titles={LANE_SHARE_REASONING_TITLES}
                    disabled={disabled}
                    onChange={(reasoningLevels) => set("run", { reasoningLevels })}
                  />
                </ModernRow>
                <ModernRow title="Permission modes" hint={rights.run.permissionModes.length === 0 ? "None picked: the chat's current mode only." : undefined}>
                  <MultiPick
                    label="Permission modes a guest may use"
                    options={AGENT_CHAT_PERMISSION_MODE_VALUES}
                    values={rights.run.permissionModes}
                    titles={LANE_SHARE_MODE_TITLES}
                    disabled={disabled}
                    onChange={(permissionModes) => set("run", { permissionModes })}
                  />
                </ModernRow>
              </>
            ) : null}
          </Group>

          <Group id="decide" title="What they can answer">
            <ToggleRow title="Approve the agent's actions" checked={rights.decide.approvals} disabled={disabled} onChange={(approvals) => set("decide", { approvals })} />
            <ToggleRow title="Answer the agent's questions" checked={rights.decide.questions} disabled={disabled} onChange={(questions) => set("decide", { questions })} />
          </Group>

          <Group id="tools" title="What they can read">
            {LANE_SHARE_TOOL_DOMAINS.filter((domain) => LANE_SHARE_TOOL_READS[domain].length > 0 || rights.tools[domain]).map((domain) => {
              const reads = LANE_SHARE_TOOL_READS[domain];
              return (
                <ToggleRow
                  key={domain}
                  title={TOOL_TITLES[domain]}
                  hint={reads.length === 0 ? "Gives nothing yet. Turn it off to tidy up." : reads[0]}
                  checked={rights.tools[domain]}
                  // A switch with no reads gives nothing: it shows only while on, so it can be turned off.
                  disabled={disabled || (reads.length === 0 && !rights.tools[domain])}
                  onChange={(value) => onChange({ ...rights, tools: { ...rights.tools, [domain]: value } })}
                />
              );
            })}
          </Group>

          <Group id="limits" title="Message limits">
            <ModernRow
              title="Messages a day"
              hint="Counted on your computer's day."
              control={(
                <input
                  className="kit-input kit-num ade-ls-limit"
                  inputMode="numeric"
                  disabled={disabled}
                  value={rights.limits.messagesPerDay ?? ""}
                  placeholder="No limit"
                  aria-label="Messages a day"
                  onChange={(event) => setLimits({ messagesPerDay: limitValue(event.target.value) })}
                />
              )}
            />
            <ModernRow
              title="Messages in total"
              control={(
                <input
                  className="kit-input kit-num ade-ls-limit"
                  inputMode="numeric"
                  disabled={disabled}
                  value={rights.limits.messagesTotal ?? ""}
                  placeholder="No limit"
                  aria-label="Messages in total"
                  onChange={(event) => setLimits({ messagesTotal: limitValue(event.target.value) })}
                />
              )}
            />
          </Group>
        </div>
      ) : null}
    </div>
  );
}
