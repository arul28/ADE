import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { AgentChatMessageList } from "../../chat/AgentChatMessageList";
import { buildChatAppearanceRootStyle } from "../../chat/chatAppearance";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { Banner } from "../../ui/notice";
import { ToolLogo } from "../ToolLogos";
import { PROVIDER_TOOL_TYPE, type ExternalSessionSummary } from "./contract";
import { modelDisplayName, type SessionPlace } from "./importBrowserModel";
import { LiveBadge, MetaSeparator, PlaceLabel } from "./ImportSessionParts";
import { formatPromptCount, formatUpdatedAt, sessionHeading } from "./sessionPresentation";
import { useExternalSessionDetail } from "./useExternalSessionDetail";
import { formatExternalSessionSize } from "../../../../shared/externalSessionAffordances";
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
        className="kit-icon-btn import-copy-btn"
      >
        {copied ? <Check size={12} weight="bold" className="text-emerald-300" /> : <Copy size={12} />}
      </button>
    </SmartTooltip>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="import-transcript-skeleton flex flex-col gap-4 px-6 py-6" aria-hidden="true">
      <div className="ml-auto h-9 w-1/2 animate-pulse" />
      <div className="h-4 w-4/5 animate-pulse" />
      <div className="h-4 w-3/5 animate-pulse" />
      <div className="ml-auto h-9 w-2/5 animate-pulse" />
      <div className="h-4 w-2/3 animate-pulse" />
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
    formatUpdatedAt(summary.updatedAt) ? { key: "time", node: <span className="kit-num">{formatUpdatedAt(summary.updatedAt)}</span> } : null,
    formatPromptCount(summary.messageCount) ? { key: "prompts", node: <span>{formatPromptCount(summary.messageCount)}</span> } : null,
    model ? { key: "model", node: <span className="max-w-[160px] truncate">{model}</span> } : null,
    formatExternalSessionSize(summary.sizeBytes) ? { key: "size", node: <span className="kit-num">{formatExternalSessionSize(summary.sizeBytes)}</span> } : null,
  ];
  const meta = metaEntries.filter((entry): entry is { key: string; node: ReactNode } => entry != null);

  return (
    <>
      <header className="import-preview-head">
        <div className="import-preview-title">
          <ToolLogo toolType={PROVIDER_TOOL_TYPE[summary.provider]} size={18} className="shrink-0" />
          <h3 title={heading}>{heading}</h3>
          {summary.possiblyActive ? <LiveBadge /> : null}
          <CopyIdButton id={summary.id} />
        </div>
        <div className="import-meta">
          <PlaceLabel place={place} className="max-w-[220px] text-(--kit-text-2)" />
          {meta.map((entry) => (
            <span key={entry.key} className="inline-flex min-w-0 items-center gap-1.5">
              <MetaSeparator />
              {entry.node}
            </span>
          ))}
        </div>
      </header>
      <div
        className="import-transcript relative flex min-h-0 flex-1 flex-col"
        role="region"
        aria-label="Session conversation"
        data-import-transcript=""
        data-chat-appearance-root=""
        style={appearanceStyle}
      >
        {transcript.error ? (
          <Banner
            layout="inline"
            style={{ margin: "12px 20px 0", flexShrink: 0 }}
            model={{
              id: "import-session-preview-error",
              tone: "warning",
              title: transcript.error,
              ...(transcript.events.length ? { detail: "Showing the saved message snippets instead." } : {}),
            }}
          />
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
          <div className="import-center text-[12px] text-(--kit-text-3)">
            No messages to show.
          </div>
        )}
      </div>
    </>
  );
});
