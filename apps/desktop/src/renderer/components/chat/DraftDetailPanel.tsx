import { ArrowUUpLeft, CalendarBlank, CopySimple, Image, PaperPlaneTilt, PencilSimple } from "@phosphor-icons/react";
import React from "react";
import type { DraftEntry, OpenProjectBinding } from "../../../shared/types";
import { Banner } from "../ui/notice/Banner";
import { draftAttachmentCount, draftAttachmentsUnavailable, draftMetaLine, isPendingSchedule, isScheduledEntry, needsAttention, providerLabel } from "./draftsFormat";

export type DraftDetailPanelProps = {
  entry: DraftEntry;
  /** The edited prompt, owned by the parent so a re-render keeps the caret. */
  text: string;
  onTextChange: (value: string) => void;
  busy: boolean;
  /** The machine whose runtime holds this row's images. */
  composerMachineBinding: OpenProjectBinding | null;
  /** Back to the list, keeping the menu open. */
  onBack: () => void;
  /** Dismiss the whole menu. */
  onClose: () => void;
  onSaveEdit: (entry: DraftEntry, text: string) => void;
  onAttach: (entry: DraftEntry) => void;
  onSendNow: (entry: DraftEntry) => void;
  onDuplicate: (entry: DraftEntry) => void;
  /** Absent hides the schedule action. */
  onSchedule?: ((entry: DraftEntry) => void) | undefined;
};

/**
 * One draft, opened: the full prompt as editable text, what it carries, and
 * the actions a person actually wants from it. Split out of the menu component
 * so that component stays about the list and its own state.
 */
export function DraftDetailPanel({
  entry,
  text,
  onTextChange,
  busy,
  composerMachineBinding: _composerMachineBinding,
  onBack,
  onClose,
  onSaveEdit,
  onAttach,
  onSendNow,
  onDuplicate,
  onSchedule,
}: DraftDetailPanelProps) {
  const scheduled = isScheduledEntry(entry);
  const attachmentsUnavailable = draftAttachmentsUnavailable(entry);

  return (
            <div className="flex min-h-0 flex-1 flex-col" data-draft-detail="">
              <div className="flex items-center justify-between gap-3 border-b border-fg/[0.06] px-3.5 py-2.5">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/50 transition-colors hover:bg-fg/[0.05] hover:text-fg/75"
                  onClick={onBack}
                >
                  <ArrowUUpLeft size={11} aria-hidden />
                  All drafts
                </button>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/45 transition-colors hover:bg-fg/[0.05] hover:text-fg/70"
                  onClick={onClose}
                >
                  Close
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <div className="font-sans text-[9.5px] font-semibold uppercase tracking-wide text-muted-fg/40">
                  {needsAttention(entry) ? "Needs you" : isScheduledEntry(entry) ? "Scheduled" : "Draft"}
                </div>
                <textarea
                  value={text}
                  onChange={(event) => onTextChange(event.target.value)}
                  rows={Math.min(12, Math.max(4, text.split("\n").length + 1))}
                  className="mt-1.5 w-full resize-none rounded-xl border border-fg/[0.09] bg-black/25 px-2.5 py-2 font-sans text-[11.5px] leading-5 text-fg/85 outline-none focus:border-violet-400/40"
                />
                {draftAttachmentCount(entry) > 0 ? (
                  <div className="mt-2 flex items-center gap-1.5 font-mono text-[9.5px] text-muted-fg/45">
                    <Image size={11} aria-hidden />
                    {draftAttachmentCount(entry)} image{draftAttachmentCount(entry) === 1 ? "" : "s"}
                    {draftAttachmentsUnavailable(entry) ? " on another machine" : ""}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-muted-fg/45">
                  {providerLabel(entry) ? <span>{providerLabel(entry)}</span> : null}
                  {entry.modelId ?? entry.model ? (
                    <span className="truncate">{entry.modelId ?? entry.model}</span>
                  ) : null}
                  {entry.permissionMode ? (
                    <span className="rounded bg-fg/[0.06] px-1 py-px">{entry.permissionMode}</span>
                  ) : null}
                </div>
                {isScheduledEntry(entry) ? (
                  <div className="mt-2 flex items-center gap-1.5 font-sans text-[10.5px] text-fg/65">
                    <CalendarBlank size={12} className="text-muted-fg/45" aria-hidden />
                    {draftMetaLine(entry)}
                    {entry.deliveryPolicy ? (
                      <span className="text-muted-fg/42">
                        · {entry.deliveryPolicy === "wait" ? "wait for me" : entry.deliveryPolicy}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {needsAttention(entry) ? (
                  <Banner
                    layout="inline"
                    style={{ marginTop: 8 }}
                    model={{
                      id: `draft-needs-you-${entry.id}`,
                      tone: "warning",
                      title: entry.lastError?.trim() || "This send could not go out.",
                    }}
                  />
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 border-t border-fg/[0.06] px-3 py-2.5">
                <button
                  type="button"
                  disabled={busy || text === entry.text}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-sans text-[11px] text-fg/70 transition-colors hover:bg-fg/[0.05] disabled:cursor-not-allowed disabled:opacity-35"
                  onClick={() => onSaveEdit(entry, text)}
                >
                  <PencilSimple size={12} aria-hidden />
                  Save
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-sans text-[11px] text-fg/60 transition-colors hover:bg-fg/[0.05] hover:text-fg/80 disabled:cursor-not-allowed disabled:opacity-35"
                  onClick={() => onDuplicate(entry)}
                >
                  <CopySimple size={12} aria-hidden />
                  Duplicate
                </button>
                {onSchedule ? (
                  <button
                    type="button"
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-sans text-[11px] text-fg/70 transition-colors hover:bg-violet-500/[0.10] hover:text-violet-100/85 disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={() => onSchedule(entry)}
                  >
                    <CalendarBlank size={12} aria-hidden />
                    {scheduled ? "Reschedule" : "Schedule send"}
                  </button>
                ) : null}
                {scheduled && isPendingSchedule(entry) ? (
                  <button
                    type="button"
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-sans text-[11px] text-fg/70 transition-colors hover:bg-emerald-500/[0.10] hover:text-emerald-100/85 disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={() => onSendNow(entry)}
                  >
                    <PaperPlaneTilt size={12} aria-hidden />
                    Send now
                  </button>
                ) : null}
                <button
                  type="button"
                  // A draft whose images live on another machine cannot be
                  // attached; a live button that only ever errors is worse than
                  // an inert one with the reason already on screen.
                  disabled={busy || attachmentsUnavailable}
                  title={attachmentsUnavailable
                    ? "These images live on the machine where this draft was made."
                    : undefined}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-violet-500/85 px-2.5 py-1.5 font-sans text-[11px] font-semibold text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => onAttach(entry)}
                >
                  <ArrowUUpLeft size={12} aria-hidden />
                  Attach to composer
                </button>
              </div>
            </div>
  );
}
