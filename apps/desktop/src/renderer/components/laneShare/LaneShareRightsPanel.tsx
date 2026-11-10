import React from "react";
import { WarningOctagon, Warning, ShieldCheck } from "@phosphor-icons/react";
import {
  LANE_SHARE_TOOL_DOMAINS,
  LANE_SHARE_TOOL_READS,
  laneShareLowRiskSummary,
  laneShareRiskLevel,
  type LaneShareRights,
  type LaneShareToolDomain,
} from "../../../shared/laneShareRights";
import { AGENT_CHAT_PERMISSION_MODE_VALUES, type AgentChatPermissionMode } from "../../../shared/types/chat";
import { SettingsToggle } from "../settings/primitives/SettingsControls";
import { LANE_SHARE_RISK_LABELS, formatLaneShareEnd, laneShareQuickEnds } from "./laneShareModel";

/**
 * The rights of one person, in the groups See, Speak, Run, Decide, Tools,
 * Limits and Privacy. Every switch writes one field of `LaneShareRights`; the
 * risk level and its reasons come from `laneShareRiskLevel`, live.
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

const MODE_TITLES: Record<AgentChatPermissionMode, string> = {
  default: "Ask first",
  plan: "Plan",
  auto: "Auto",
  edit: "Edit",
  "full-auto": "Full auto",
  "config-toml": "Provider config",
};

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5" data-testid={`lane-share-group-${title.toLowerCase()}`}>
      <div className="kit-eyebrow pb-1 pt-2">{title}</div>
      {children}
    </section>
  );
}

function Row({
  title,
  hint,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-1">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-[1.4] text-fg/85">{title}</div>
        {hint ? <div className="text-[11px] leading-[1.35] text-fg/45">{hint}</div> : null}
      </div>
      <SettingsToggle label={title} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function listText(values: readonly string[]): string {
  return values.join(", ");
}

function parseList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean))];
}

function limitValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function LaneShareRiskSummary({ rights }: { rights: LaneShareRights }) {
  const risk = laneShareRiskLevel(rights);
  const tone = risk.level === "high" ? "crit" : risk.level === "medium" ? "warn" : "ok";
  const Icon = risk.level === "high" ? WarningOctagon : risk.level === "medium" ? Warning : ShieldCheck;
  return (
    <div className="kit-panel flex flex-col gap-1.5 p-3" data-testid="lane-share-risk" data-level={risk.level}>
      <div className="flex items-center gap-2">
        <Icon size={14} weight="duotone" style={{ color: `var(--kit-${tone})` }} />
        <span className="kit-tag" data-tone={tone}>{LANE_SHARE_RISK_LABELS[risk.level]}</span>
      </div>
      {risk.reasons.length > 0 ? (
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[11px] leading-[1.45] text-fg/65">
          {risk.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : (
        <div className="text-[11px] text-fg/55">{laneShareLowRiskSummary(rights)}</div>
      )}
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
}: {
  rights: LaneShareRights;
  endsAt: number | null;
  onChange: (next: LaneShareRights) => void;
  onEndsAtChange: (next: number | null) => void;
  disabled?: boolean;
  now: number;
}) {
  const set = <G extends "see" | "speak" | "run" | "decide" | "privacy">(group: G, patch: Partial<LaneShareRights[G]>) =>
    onChange({ ...rights, [group]: { ...rights[group], ...patch } });
  const setLimits = (patch: Partial<LaneShareRights["limits"]>) => onChange({ ...rights, limits: { ...rights.limits, ...patch } });
  const [modelsText, setModelsText] = React.useState(listText(rights.run.models));
  const [levelsText, setLevelsText] = React.useState(listText(rights.run.reasoningLevels));
  React.useEffect(() => setModelsText(listText(rights.run.models)), [rights.run.models]);
  React.useEffect(() => setLevelsText(listText(rights.run.reasoningLevels)), [rights.run.reasoningLevels]);
  const quickEnds = laneShareQuickEnds(now);

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="lane-share-rights">
      <Group title="See">
        <Row title="Chats" checked={rights.see.chats} disabled={disabled} onChange={(chats) => set("see", { chats })} />
        <Row title="Subagent chats" checked={rights.see.subagentChats} disabled={disabled} onChange={(subagentChats) => set("see", { subagentChats })} />
        <Row title="CLI sessions" checked={rights.see.cliSessions} disabled={disabled} onChange={(cliSessions) => set("see", { cliSessions })} />
        <Row title="Shells" checked={rights.see.shells} disabled={disabled} onChange={(shells) => set("see", { shells })} />
        <div className="py-1 text-[11px] leading-[1.4] text-fg/50">Shells are always read only. A guest never types into or starts a shell.</div>
        <Row
          title="History before the share"
          hint="Off: only what happens from now on."
          checked={rights.see.historyBeforeShare}
          disabled={disabled}
          onChange={(historyBeforeShare) => set("see", { historyBeforeShare })}
        />
      </Group>

      <Group title="Speak">
        <Row title="Comment on replies" checked={rights.speak.comment} disabled={disabled} onChange={(comment) => set("speak", { comment })} />
        <Row title="Write drafts" hint="Only you send a draft." checked={rights.speak.drafts} disabled={disabled} onChange={(drafts) => set("speak", { drafts })} />
        <Row title="Send messages" checked={rights.speak.send} disabled={disabled} onChange={(send) => set("speak", { send })} />
        <Row title="Steer their own turns" checked={rights.speak.steer} disabled={disabled} onChange={(steer) => set("speak", { steer })} />
        <Row title="Stop or steer any turn" hint="Also yours and other guests'." checked={rights.speak.interruptAnyTurn} disabled={disabled} onChange={(interruptAnyTurn) => set("speak", { interruptAnyTurn })} />
      </Group>

      <Group title="Run">
        <Row title="Start chats" checked={rights.run.startChats} disabled={disabled} onChange={(startChats) => set("run", { startChats })} />
        <Row title="Start CLI sessions" checked={rights.run.startCliSessions} disabled={disabled} onChange={(startCliSessions) => set("run", { startCliSessions })} />
        <Row
          title="Type into CLI sessions"
          hint="Same reach as a shell. Refused on a Windows host."
          checked={rights.run.typeInCliSessions}
          disabled={disabled}
          onChange={(typeInCliSessions) => set("run", { typeInCliSessions })}
        />
        <label className="flex flex-col gap-1 py-1">
          <span className="text-[12px] text-fg/85">Models</span>
          <input
            className="kit-input"
            value={modelsText}
            disabled={disabled}
            placeholder="Empty: the chat's current model only"
            onChange={(event) => setModelsText(event.target.value)}
            onBlur={() => set("run", { models: parseList(modelsText) })}
            aria-label="Models a guest may use"
          />
        </label>
        <label className="flex flex-col gap-1 py-1">
          <span className="text-[12px] text-fg/85">Reasoning levels</span>
          <input
            className="kit-input"
            value={levelsText}
            disabled={disabled}
            placeholder="Empty: the chat's current level only"
            onChange={(event) => setLevelsText(event.target.value)}
            onBlur={() => set("run", { reasoningLevels: parseList(levelsText) })}
            aria-label="Reasoning levels a guest may pick"
          />
        </label>
        <div className="flex flex-col gap-1 py-1">
          <span className="text-[12px] text-fg/85">Permission modes</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {AGENT_CHAT_PERMISSION_MODE_VALUES.map((mode) => (
              <label key={mode} className="flex items-center gap-1.5 text-[11px] text-fg/75">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={rights.run.permissionModes.includes(mode)}
                  onChange={(event) => set("run", {
                    permissionModes: event.target.checked
                      ? [...rights.run.permissionModes, mode]
                      : rights.run.permissionModes.filter((value) => value !== mode),
                  })}
                />
                {MODE_TITLES[mode]}
              </label>
            ))}
          </div>
          <span className="text-[11px] text-fg/45">None ticked: the chat's current mode only.</span>
        </div>
      </Group>

      <Group title="Decide">
        <Row title="Approve the agent's actions" checked={rights.decide.approvals} disabled={disabled} onChange={(approvals) => set("decide", { approvals })} />
        <Row title="Answer the agent's questions" checked={rights.decide.questions} disabled={disabled} onChange={(questions) => set("decide", { questions })} />
      </Group>

      <Group title="Tools">
        {LANE_SHARE_TOOL_DOMAINS.map((domain) => {
          const reads = LANE_SHARE_TOOL_READS[domain];
          const inert = reads.length === 0;
          return (
            <Row
              key={domain}
              title={TOOL_TITLES[domain]}
              hint={inert ? "No access yet." : reads.join(". ")}
              checked={rights.tools[domain]}
              // A switch with no reads gives nothing: it stays as saved and can be turned off.
              disabled={disabled || (inert && !rights.tools[domain])}
              onChange={(value) => onChange({ ...rights, tools: { ...rights.tools, [domain]: value } })}
            />
          );
        })}
      </Group>

      <Group title="Limits">
        <div className="grid grid-cols-2 gap-2 py-1">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] text-fg/85">Messages a day</span>
            <input
              className="kit-input kit-num"
              inputMode="numeric"
              disabled={disabled}
              value={rights.limits.messagesPerDay ?? ""}
              placeholder="No limit"
              onChange={(event) => setLimits({ messagesPerDay: limitValue(event.target.value) })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] text-fg/85">Messages in total</span>
            <input
              className="kit-input kit-num"
              inputMode="numeric"
              disabled={disabled}
              value={rights.limits.messagesTotal ?? ""}
              placeholder="No limit"
              onChange={(event) => setLimits({ messagesTotal: limitValue(event.target.value) })}
            />
          </label>
        </div>
        <div className="flex flex-col gap-1 py-1">
          <span className="text-[12px] text-fg/85">{formatLaneShareEnd(endsAt)}</span>
          <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label="Share end">
            {quickEnds.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                disabled={disabled}
                aria-checked={option.at == null ? endsAt == null : false}
                onClick={() => onEndsAtChange(option.at)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </Group>

      <Group title="Privacy">
        <Row title="Hide my machines" hint="No machine name or kind." checked={rights.privacy.hideMachines} disabled={disabled} onChange={(hideMachines) => set("privacy", { hideMachines })} />
        <Row title="Hide my models" hint="Only the models above." checked={rights.privacy.hideModels} disabled={disabled} onChange={(hideModels) => set("privacy", { hideModels })} />
      </Group>
    </div>
  );
}
