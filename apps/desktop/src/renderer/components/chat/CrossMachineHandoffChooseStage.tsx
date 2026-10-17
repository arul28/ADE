import type { ReactNode } from "react";
import { CheckCircle, Desktop, GitBranch, Hourglass } from "@phosphor-icons/react";
import type { AgentChatCrossMachineHandoffMachineOption } from "../../../shared/types";
import { BlockedReasons, type BlockedActionReason } from "../shared/BlockedAction";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice/Banner";
import {
  CheckRow,
  repoReadinessClass,
  repoReadinessLabel,
  type HandoffMode,
} from "./crossMachineHandoffPresentation";

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
  return (
    <div className="space-y-5">
      <div>
        <div className="inline-flex w-full rounded-lg border border-fg/[0.07] bg-fg/[0.02] p-0.5">
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
                  "flex-1 rounded-md px-3 py-1.5 font-sans text-[11px] font-semibold transition-colors",
                  active ? "bg-sky-400/[0.14] text-sky-50 shadow-[inset_0_0_0_1px_rgba(125,211,252,0.28)]" : "text-fg/52 hover:text-fg/78",
                  disabled && "cursor-not-allowed opacity-40 hover:text-fg/52",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="mt-1.5 text-[10px] leading-4 text-fg/46">
          {!sourceProviderSupportsFork
            ? `${providerLabel} can't fork chat history — send a brief instead.`
            : mode === "fork"
              ? "Sends the full history so the new chat picks up exactly where this one left off."
              : "Sends a short summary; the new chat starts fresh from it."}
        </div>
      </div>
      <div className="grid gap-5 md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      <div className="space-y-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/38">Get this machine ready</div>
          <div className="mt-1 text-[11px] leading-4 text-fg/48">Commit and push your work, or bring it along with the move.</div>
        </div>
        {loading && !optionsLoaded ? (
          <CheckRow label="Checking this chat" detail="Branch, changes and machines" state="pending" />
        ) : optionsLoaded && continueBlockers.length === 0 ? (
          <CheckRow
            label="Ready to move"
            detail={includeChanges
              ? `Your ${changesLabel ?? "uncommitted work"} travels with this move`
              : "Nothing here blocks the move"}
            state="ok"
          />
        ) : null}
        {/* Every blocker renders here and only here. */}
        <BlockedReasons
          reasons={loading && !optionsLoaded ? [] : continueBlockers}
          {...(continueBlockers.length > 1
            ? { heading: `${continueBlockers.length} things to fix first` }
            : {})}
        />
        {includeChanges ? (
          <Banner
            layout="inline"
            testId="handoff-bring-changes"
            model={{
              id: "handoff-bring-changes",
              tone: "accent",
              icon: <GitBranch size={13} weight="bold" />,
              title: changesLabel ? `Bringing ${changesLabel} along` : "Bringing your uncommitted work along",
              detail: ".env and other ignored files stay here.",
              actions: [{ label: "Leave them here", variant: "link", onClick: onLeaveChangesHere }],
            }}
          />
        ) : null}
        {queueOnly ? (
          <Banner
            layout="inline"
            testId="handoff-when-turn-ends"
            model={{
              id: "handoff-when-turn-ends",
              tone: "info",
              icon: <Hourglass size={13} weight="bold" />,
              title: "Moves when this turn ends",
              detail: queuedCloneApproved
                ? `ADE checks everything again then, and clones the repository on ${selectedMachineName ?? "that machine"}.`
                : "ADE checks everything again then. A new message from you keeps it here.",
              actions: [
                { label: "Stop current response", variant: "secondary", disabled: busy, onClick: () => void onStopTurn() },
                { label: "Don't wait", variant: "link", onClick: onDontWait },
              ],
            }}
          />
        ) : null}
      </div>

      <div className="space-y-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/38">Choose a machine</div>
          <div className="mt-1 text-[11px] leading-4 text-fg/48">Your other ADE machines appear here.</div>
        </div>
        <div className="space-y-2">
          {machines.map((machine) => {
            const available = machineAvailable(machine);
            const selected = selectedMachineKey === machine.machineKey;
            const readiness = machine.hasRepository === true
              ? "present"
              : machine.hasRepository === false
                ? "absent"
                : undefined;
            const readinessLabel = repoReadinessLabel(readiness);
            return (
              <button
                key={machine.machineKey}
                type="button"
                disabled={!available}
                onClick={() => onSelectMachine(machine.machineKey)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                  selected
                    ? "border-sky-300/26 bg-sky-400/[0.09]"
                    : "border-fg/[0.065] bg-fg/[0.025] hover:bg-fg/[0.045]",
                )}
              >
                <div className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", selected ? "bg-sky-300/12 text-sky-200" : "bg-fg/[0.04] text-fg/48")}>
                  <Desktop size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-semibold text-fg/82">{machine.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg/42">
                    {available ? (
                      <>
                        <span className="kit-dot" data-state="ok" aria-hidden />
                        Online
                        {readinessLabel ? (
                          <>
                            <span className="text-fg/22">·</span>
                            <span className={repoReadinessClass(readiness)}>{readinessLabel}</span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span>{machine.unavailableReason ?? "Offline"}</span>
                    )}
                  </div>
                </div>
                {selected ? <CheckCircle size={16} weight="fill" className="text-sky-200" /> : null}
              </button>
            );
          })}
          {optionsLoaded && machines.length === 0 ? (
            <div className="rounded-xl border border-dashed border-fg/[0.09] px-4 py-6 text-center">
              <Desktop size={22} className="mx-auto text-fg/28" />
              <div className="mt-2 text-[11px] font-semibold text-fg/62">No other machines on this account</div>
              <div className="mt-1 text-[10px] leading-4 text-fg/40">
                Sign in to ADE on another computer with this account, then reopen this setup.
              </div>
            </div>
          ) : null}
        </div>
        {newChatControls}
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg/38">Note for the new chat</span>
          <textarea
            value={continuationPrompt}
            onChange={(event) => onContinuationPromptChange(event.target.value)}
            maxLength={4000}
            rows={4}
            placeholder={mode === "fork"
              ? "Optional. Tell the new chat what to do next; otherwise it just keeps going from the full history."
              : "Optional. Tell the new chat what to do next; otherwise it just continues from the summary."}
            className="mt-1.5 min-h-[82px] w-full resize-y rounded-lg border border-fg/[0.075] bg-black/20 px-3 py-2 text-[11px] leading-4 text-fg/78 outline-none placeholder:text-fg/28 focus:border-sky-300/25"
          />
          <span className="mt-1 block text-right text-[9px] text-fg/28">{continuationPrompt.length} / 4,000</span>
        </label>
      </div>
      </div>
    </div>
  );
}
