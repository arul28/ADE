import { memo, useCallback, useEffect, useRef } from "react";
import { Gift } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { usePinnedToolStatus } from "../../../hooks/usePinnedToolStatus";
import { Banner } from "../../ui/notice";
import { PickerEmptyMessage, type PickerEmptyAction } from "./PickerEmptyMessage";

/**
 * The Free page with no rows yet. Free models run in ADE's pinned OpenCode on
 * the picker's machine, so the page gets that copy when it is missing, shows
 * the download while it runs, and lists the models once the catalog loads.
 *
 * Mounted only while the page is empty, so a picker with free rows does no
 * status read at all.
 */
export const FreeModelsEmptyState = memo(function FreeModelsEmptyState({
  runtimePin,
  opencodeInstalled,
  catalogRefreshing,
  catalogRefreshFailed,
  onReady,
  onRefresh,
}: {
  runtimePin: OpenProjectBinding | null;
  /** The picker's own probe: true once OpenCode is on the machine. */
  opencodeInstalled: boolean | null;
  catalogRefreshing: boolean;
  /** OpenCode's last catalog read failed. */
  catalogRefreshFailed: boolean;
  /** Re-reads the machine: when a download this page watched lands, or when the tool is ready but the picker does not know yet. */
  onReady: () => void;
  /** Reloads the free models from OpenCode. */
  onRefresh?: () => void;
}) {
  const tool = usePinnedToolStatus("opencode", runtimePin, {
    onReady,
    enabled: opencodeInstalled !== true,
  });
  const { status, error, starting, download } = tool;
  const handleDownload = useCallback(() => {
    void download();
  }, [download]);

  const downloading = starting || status?.state === "downloading" || status?.downloading === true;
  const ready = opencodeInstalled === true || status?.state === "ready";

  // OpenCode is on the machine (another download got it), but the picker's
  // probe has not seen it: re-read the machine once, or the page waits forever.
  const toolReadyPickerUnaware = status?.state === "ready" && opencodeInstalled !== true;
  const rereadRef = useRef(false);
  useEffect(() => {
    if (!toolReadyPickerUnaware || rereadRef.current) return;
    rereadRef.current = true;
    onReady();
  }, [onReady, toolReadyPickerUnaware]);

  if (ready && !downloading) {
    // A download that just landed: the picker re-reads the machine and the
    // catalog next, so this is loading, not an empty list.
    if (catalogRefreshing || opencodeInstalled !== true) {
      return <FreeModelsMessage title="Loading free models" live />;
    }
    if (catalogRefreshFailed) {
      return (
        <FreeModelsMessage
          title="Couldn’t load free models"
          body="OpenCode did not return its model list."
          {...(onRefresh ? { action: { label: "Try again", onClick: onRefresh } } : {})}
        />
      );
    }
    return (
      <FreeModelsMessage
        title="No free models right now"
        body="The free list changes over time. Check again soon."
        {...(onRefresh ? { action: { label: "Check again", onClick: onRefresh } } : {})}
      />
    );
  }

  if (downloading) {
    const total = status?.totalBytes ?? null;
    const received = status?.receivedBytes ?? null;
    const percent = total && received != null ? Math.min(100, Math.floor((received / total) * 100)) : null;
    return (
      <FreeModelsMessage
        title="Getting free models…"
        body={percent != null ? `${percent}% downloaded` : "Downloading OpenCode for this machine."}
        progress={percent}
        live
      />
    );
  }

  if (status?.state === "failed") {
    return (
      <FreeModelsMessage
        title="Couldn’t get free models"
        body={status.failureReason ? `${capitalized(status.failureReason)}.` : "The download stopped."}
        action={{ label: "Try again", onClick: handleDownload }}
        error={error}
      />
    );
  }

  if (status && !status.fetchAllowed) {
    return (
      <FreeModelsMessage
        title="Free models"
        body={status.message ?? "Downloads are turned off on this machine."}
      />
    );
  }

  // Missing, or not read yet: the button works either way.
  return (
    <FreeModelsMessage
      title="Get free models"
      body="Chat with free models. No account, plan or key."
      action={{ label: "Get free models", onClick: handleDownload }}
      error={error}
    />
  );
});

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function FreeModelsMessage({
  title,
  body,
  action,
  progress,
  error,
  live,
}: {
  title: string;
  body?: string;
  action?: PickerEmptyAction;
  /** 0–100 for a known download size; null draws no bar. */
  progress?: number | null;
  /** A download that could not start (`usePinnedToolStatus`'s error). */
  error?: string | null;
  live?: boolean;
}) {
  return (
    <PickerEmptyMessage
      dataAttributes={{ "data-model-picker-empty-state": "free" }}
      icon={(
        <span
          aria-hidden
          className="mb-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-sky-400/[0.10] text-sky-300"
        >
          <Gift size={16} weight="fill" />
        </span>
      )}
      title={title}
      {...(body ? { body } : {})}
      {...(action ? { primary: action } : {})}
      {...(live ? { live } : {})}
    >
      {progress != null ? (
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="mt-1 block h-1 w-40 overflow-hidden rounded-full bg-fg/[0.08]"
        >
          <span
            className="block h-full rounded-full bg-sky-300/80 transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </span>
      ) : null}
      {error ? (
        <div className="w-full max-w-[300px] text-left">
          <Banner layout="inline" model={{ id: "free-models-download-error", tone: "error", title: error }} />
        </div>
      ) : null}
    </PickerEmptyMessage>
  );
}
