import { useState, type ReactNode } from "react";
import { Check, CheckCircle, CircleNotch, Desktop, GitBranch, Hourglass } from "@phosphor-icons/react";
import type { AgentChatCrossMachineHandoffMachineOption } from "../../../shared/types";
import { BlockedReasons, type BlockedActionReason } from "../shared/BlockedAction";
import { cn } from "../ui/cn";
import type { HandoffMode } from "./crossMachineHandoffPresentation";

export function machineAvailable(machine: AgentChatCrossMachineHandoffMachineOption): boolean {
  return machine.online && !machine.unavailableReason;
}

/**
 * The setup modal's first step: fork or brief, what blocks the move here, the
 * machine to continue on, the new chat's controls, and a note for it. Holds no
 * state; the modal owns every choice and passes it down.
 */
export function CrossMachineHandoffChooseStage({
  mode,
  sourceProviderSupportsFork,
  providerLabel,
  onSwitchMode,
  loading,
  optionsLoaded,
  continueBlockers,
  includeChanges,
  changesLabel,
  onLeaveChangesHere,
  queueOnly,
  queuedCloneApproved,
  busy,
  onStopTurn,
  onDontWait,
  machines,
  selectedMachineKey,
  selectedMachineName,
  onSelectMachine,
  newChatControls,
  continuationPrompt,
  onContinuationPromptChange,
}: {
  mode: HandoffMode;
  sourceProviderSupportsFork: boolean;
  providerLabel: string;
  onSwitchMode: (mode: HandoffMode) => void;
  loading: boolean;
  /** The brain has answered at least once. */
  optionsLoaded: boolean;
  continueBlockers: BlockedActionReason[];
  includeChanges: boolean;
  changesLabel: string | null;
  onLeaveChangesHere: () => void;
  /** A busy chat set to move once its turn ends. */
  queueOnly: boolean;
  queuedCloneApproved: boolean;
  busy: boolean;
  onStopTurn: () => Promise<void>;
  onDontWait: () => void;
  machines: AgentChatCrossMachineHandoffMachineOption[];
  selectedMachineKey: string | null;
  selectedMachineName: string | null;
  onSelectMachine: (machineKey: string) => void;
  /** Model, effort and permission pickers for the new chat, if offered. */
  newChatControls: ReactNode;
  continuationPrompt: string;
  onContinuationPromptChange: (next: string) => void;
}) {
  const [noteFocused, setNoteFocused] = useState(false);
  const noteExpanded = noteFocused || continuationPrompt.includes("\n") || continuationPrompt.length > 70;
  const ready = optionsLoaded && continueBlockers.length === 0;
  const modeHint = !sourceProviderSupportsFork
    ? `${providerLabel} can't fork history; it sends a brief.`
    : mode === "fork"
      ? "Sends the full history; oldest turns may drop to fit."
      : "Sends a short summary to start from.";
  return (
    <div className="space-y-3.5">
      {/* Status: one line when ready, one row per blocker otherwise. */}
      <div className="space-y-1.5" data-testid="handoff-status">
        {loading && !optionsLoaded ? (
          <StatusLine icon={<CircleNotch size={13} className="animate-spin text-fg/45" />} text="Checking this chat…" />
        ) : ready && !includeChanges && !queueOnly ? (
          <StatusLine icon={<span className="kit-dot" data-state="ok" aria-hidden />} text="Ready to move" />
        ) : null}
        <BlockedReasons variant="rows" reasons={loading && !optionsLoaded ? [] : continueBlockers} />
        {includeChanges ? (
          <StatusLine
            testId="handoff-bring-changes"
            icon={<GitBranch size={13} weight="bold" className="text-sky-300/80" />}
            text={changesLabel ? `Bringing ${changesLabel} along` : "Bringing your uncommitted work along"}
            muted=".env stays here"
            actions={<LinkButton onClick={onLeaveChangesHere}>Leave them here</LinkButton>}
          />
        ) : null}
        {queueOnly ? (
          <StatusLine
            testId="handoff-when-turn-ends"
            icon={<Hourglass size={13} weight="bold" className="text-sky-300/80" />}
            text="Moves when this turn ends"
            muted={queuedCloneApproved ? `then clones on ${selectedMachineName ?? "that machine"}` : null}
            actions={(
              <>
                <LinkButton disabled={busy} onClick={() => void onStopTurn()}>Stop response</LinkButton>
                <LinkButton onClick={onDontWait}>Don&rsquo;t wait</LinkButton>
              </>
            )}
          />
        ) : null}
      </div>

      <FormRow label="Send">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex shrink-0 rounded-md border border-fg/[0.08] bg-fg/[0.025] p-0.5">
            {([
              { value: "fork" as const, label: "Fork", disabled: !sourceProviderSupportsFork },
              { value: "brief" as const, label: "Brief", disabled: false },
            ]).map(({ value, label, disabled }) => {
              const active = mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => onSwitchMode(value)}
                  className={cn(
                    "h-6 rounded-[5px] px-3.5 font-sans text-[11px] font-semibold transition-colors",
                    active ? "bg-sky-400/[0.16] text-sky-50 shadow-[inset_0_0_0_1px_rgba(125,211,252,0.26)]" : "text-fg/52 hover:text-fg/80",
                    disabled && "cursor-not-allowed opacity-40 hover:text-fg/52",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span className="min-w-0 truncate whitespace-nowrap text-[10.5px] text-fg/45">{modeHint}</span>
        </div>
      </FormRow>

      <FormRow label="Move to" alignTop>
        {optionsLoaded && machines.length === 0 ? (
          <div className="flex h-9 items-center gap-2 rounded-lg border border-dashed border-fg/[0.1] px-3 text-[11px] text-fg/50">
            <Desktop size={14} className="shrink-0 text-fg/35" />
            <span className="whitespace-nowrap">No other ADE machines on this account yet</span>
          </div>
        ) : (
          <div aria-label="Machine" className="overflow-hidden rounded-lg border border-fg/[0.07] bg-fg/[0.02]">
            {machines.map((machine, index) => {
              const available = machineAvailable(machine);
              const selected = selectedMachineKey === machine.machineKey;
              const needsClone = available && machine.hasRepository === false;
              return (
                <button
                  key={machine.machineKey}
                  type="button"
                  aria-pressed={selected}
                  disabled={!available}
                  onClick={() => onSelectMachine(machine.machineKey)}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 px-3 text-left transition-colors disabled:cursor-not-allowed",
                    index > 0 && "border-t border-fg/[0.05]",
                    selected ? "bg-sky-400/[0.09]" : available ? "hover:bg-fg/[0.04]" : "",
                  )}
                >
                  <Desktop size={15} className={cn("shrink-0", selected ? "text-sky-200" : available ? "text-fg/55" : "text-fg/25")} />
                  <span className={cn("min-w-0 truncate text-[11.5px] font-medium", available ? "text-fg/85" : "text-fg/38")}>{machine.name}</span>
                  {needsClone ? (
                    <span className="shrink-0 whitespace-nowrap rounded border border-amber-300/20 bg-amber-400/[0.07] px-1.5 text-[9.5px] font-medium leading-4 text-amber-200/75">
                      Will clone repo
                    </span>
                  ) : available && machine.hasRepository === true ? (
                    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-emerald-300/60">
                      <Check size={10} weight="bold" aria-hidden />
                      Repo ready
                    </span>
                  ) : null}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10.5px] text-fg/42">
                    {available ? (
                      <>
                        <span className="kit-dot" data-state="ok" aria-hidden />
                        Online
                      </>
                    ) : (
                      <span className="text-fg/32">{machine.unavailableReason ?? "Offline"}</span>
                    )}
                  </span>
                  <span className="grid w-4 shrink-0 place-items-center">
                    {selected ? <CheckCircle size={15} weight="fill" className="text-sky-200" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </FormRow>

      {newChatControls ? <FormRow label="New chat">{newChatControls}</FormRow> : null}

      <FormRow label="Note" alignTop={noteExpanded}>
        <textarea
          aria-label="Note for the new chat"
          value={continuationPrompt}
          onChange={(event) => onContinuationPromptChange(event.target.value)}
          onFocus={() => setNoteFocused(true)}
          onBlur={() => setNoteFocused(false)}
          maxLength={4000}
          rows={noteExpanded ? 4 : 1}
          placeholder="Optional: what should the new chat do next?"
          className={cn(
            "block w-full resize-none rounded-md border border-fg/[0.08] bg-black/20 px-2.5 text-[11px] text-fg/80 outline-none placeholder:text-fg/30 focus:border-sky-300/25",
            noteExpanded ? "min-h-[72px] py-1.5 leading-4" : "h-8 overflow-hidden whitespace-nowrap py-[7px] leading-4",
          )}
        />
        {continuationPrompt.length > 3500 ? (
          <span className="mt-1 block text-right text-[9.5px] text-fg/35">{continuationPrompt.length} / 4,000</span>
        ) : null}
      </FormRow>
    </div>
  );
}

/** A labelled form row: a fixed label column, then the control. */
function FormRow({ label, alignTop = false, children }: { label: string; alignTop?: boolean; children: ReactNode }) {
  return (
    <div className={cn("grid grid-cols-[72px_minmax(0,1fr)] gap-3", alignTop ? "items-start" : "items-center")}>
      <span className={cn("whitespace-nowrap text-[11px] font-medium text-fg/48", alignTop && "pt-[9px]")}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function StatusLine({
  icon,
  text,
  muted,
  actions,
  testId,
}: {
  icon: ReactNode;
  text: string;
  muted?: string | null;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-9 items-center gap-2 rounded-lg border border-fg/[0.06] bg-fg/[0.025] px-2.5 py-1"
    >
      <span className="grid w-[13px] shrink-0 place-items-center">{icon}</span>
      <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-fg/82">{text}</span>
      {muted ? <span className="min-w-0 truncate whitespace-nowrap text-[10.5px] text-fg/42">{muted}</span> : null}
      {actions ? <span className="ml-auto flex shrink-0 items-center gap-3">{actions}</span> : null}
    </div>
  );
}

function LinkButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="whitespace-nowrap text-[10.5px] font-semibold text-sky-200/80 transition-colors hover:text-sky-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
