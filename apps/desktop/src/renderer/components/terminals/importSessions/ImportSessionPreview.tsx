import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { AgentChatMessageList } from "../../chat/AgentChatMessageList";
import { buildChatAppearanceRootStyle } from "../../chat/chatAppearance";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { ToolLogo } from "../ToolLogos";
import { PROVIDER_TOOL_TYPE, type ExternalSessionSummary } from "./contract";
import { modelDisplayName, type SessionPlace } from "./importBrowserModel";
import { LiveBadge, MetaSeparator, PlaceLabel } from "./ImportSessionParts";
import {
  formatPromptCount,
  formatSessionSize,
  formatUpdatedAt,
  sessionHeading,
} from "./sessionPresentation";
import { useExternalSessionDetail } from "./useExternalSessionDetail";
import { withImportedTurnBoundaries } from "../../../../shared/importedTurnBoundaries";

function CopyIdButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback(() => {
    void copyTextToClipboard(id).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    });
  }, [id]);
  return (
    <SmartTooltip content={{ label: copied ? "Copied" : "Copy session ID", description: id }}>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy session ID"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-fg/55 transition-colors hover:bg-white/[0.06] hover:text-fg"
      >
        {copied ? <Check size={12} weight="bold" className="text-emerald-300" /> : <Copy size={12} />}
      </button>
    </SmartTooltip>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-6 py-6" aria-hidden="true">
      <div className="ml-auto h-9 w-1/2 animate-pulse rounded-2xl bg-white/[0.05]" />
      <div className="h-4 w-4/5 animate-pulse rounded bg-white/[0.04]" />
      <div className="h-4 w-3/5 animate-pulse rounded bg-white/[0.04]" />
      <div className="ml-auto h-9 w-2/5 animate-pulse rounded-2xl bg-white/[0.05]" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-white/[0.04]" />
    </div>
  );
}

/**
 * Right pane: who/where header, then the conversation rendered by the real
 * chat transcript, read-only, in its own scroll box that opens at the bottom.
 */
export const ImportSessionPreview = memo(function ImportSessionPreview({
  summary,
  place,
  runtimePin,
}: {
  summary: ExternalSessionSummary;
  place: SessionPlace;
  runtimePin: OpenProjectBinding | null;
}) {
  const chatFontSizePx = useAppStore((state) => state.chatFontSizePx);
  const chatTranscriptDensity = useAppStore((state) => state.chatTranscriptDensity);
  const appearanceStyle = useMemo(
    () => buildChatAppearanceRootStyle({ chatFontSizePx, transcriptDensity: chatTranscriptDensity }),
    [chatFontSizePx, chatTranscriptDensity],
  );
  const transcript = useExternalSessionDetail(summary, runtimePin);
  // Provider transcripts have no turn boundaries; the transcript shows
  // finished tool calls only in a turn's `done` summary.
  const transcriptEvents = useMemo(() => withImportedTurnBoundaries(transcript.events), [transcript.events]);
  const heading = sessionHeading(summary);
  const model = modelDisplayName(transcript.detail?.model ?? summary.launch?.model);
  const branch = place.kind === "lane" ? place.branch : null;
  const metaEntries: Array<{ key: string; node: ReactNode } | null> = [
    branch ? { key: "branch", node: <span className="max-w-[180px] truncate font-mono text-[10.5px]" title={branch}>{branch}</span> } : null,
    formatUpdatedAt(summary.updatedAt) ? { key: "time", node: <span>{formatUpdatedAt(summary.updatedAt)}</span> } : null,
    formatPromptCount(summary.messageCount) ? { key: "prompts", node: <span>{formatPromptCount(summary.messageCount)}</span> } : null,
    model ? { key: "model", node: <span className="max-w-[160px] truncate">{model}</span> } : null,
    formatSessionSize(summary.sizeBytes) ? { key: "size", node: <span>{formatSessionSize(summary.sizeBytes)}</span> } : null,
  ];
  const meta = metaEntries.filter((entry): entry is { key: string; node: ReactNode } => entry != null);

  return (
    <>
      <header className="shrink-0 border-b border-white/[0.06] px-5 pb-3 pt-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <ToolLogo toolType={PROVIDER_TOOL_TYPE[summary.provider]} size={18} className="shrink-0" />
          <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg" title={heading}>
            {heading}
          </h3>
          {summary.possiblyActive ? <LiveBadge /> : null}
          <CopyIdButton id={summary.id} />
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pl-[28px] text-[11px] text-muted-fg/65">
          <span className="inline-flex max-w-[220px] items-center rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-fg/80">
            <PlaceLabel place={place} />
          </span>
          {meta.map((entry) => (
            <span key={entry.key} className="inline-flex min-w-0 items-center gap-1.5">
              <MetaSeparator />
              {entry.node}
            </span>
          ))}
        </div>
      </header>
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        role="region"
        aria-label="Session conversation"
        data-import-transcript=""
        data-chat-appearance-root=""
        style={appearanceStyle}
      >
        {transcript.error ? (
          <p className="shrink-0 px-5 pt-3 text-[11px] text-amber-200/75">{transcript.error}</p>
        ) : null}
        {!transcript.loaded && !transcript.error ? (
          <TranscriptSkeleton />
        ) : transcript.events.length ? (
          <div className="min-h-0 flex-1">
            <AgentChatMessageList
              key={transcript.transcriptKey}
              events={transcriptEvents}
              sessionEnded
              textPacingEnabled={false}
              laneId={null}
              sessionId={transcript.transcriptKey}
              scrollMemoryKey={transcript.transcriptKey}
              transcriptCollapseCacheKey={transcript.transcriptKey}
              hasOlderHistory={transcript.hasOlder}
              loadingOlderHistory={transcript.loadingOlder}
              olderHistoryError={transcript.olderError}
              onLoadOlderHistory={transcript.loadOlder}
              onRetryOlderHistory={transcript.loadOlder}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-[11.5px] text-muted-fg/50">
            No messages to show.
          </div>
        )}
      </div>
    </>
  );
});
