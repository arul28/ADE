import { ArrowClockwise, CircleNotch } from "@phosphor-icons/react";
import { cloudUpdateLine, type CloudMachineUpdate } from "../../../shared/adeCloud";
import "./connections.css";

/**
 * What a cloud computer shows where another machine has an Update button: it
 * updates itself when idle, so there is nothing to press until an update
 * fails. Then Retry runs the person's own update (with its confirm).
 */
export function CloudUpdateLine({
  update,
  onRetry,
  retrying = false,
}: {
  update: CloudMachineUpdate | null | undefined;
  /** The person's update; left out, a failed line has no Retry. */
  onRetry?: (() => void) | null;
  retrying?: boolean;
}) {
  const line = cloudUpdateLine(update);
  const title = update?.image
    ? update.target && update.target !== update.image
      ? `Runs ${update.image}. Moves to ${update.target} the next time it's idle or asleep.`
      : `Runs ${update.image}, the current version for ${update.channel === "beta" ? "Beta" : "Stable"}.`
    : undefined;
  return (
    <span className="ade-cx-cloud-update" data-tone={line.tone} title={title} role={line.tone === "muted" ? undefined : "status"}>
      {line.tone === "busy" ? <CircleNotch size={11} className="animate-spin" aria-hidden /> : null}
      <span className="ade-cx-cloud-update-text">{line.text}</span>
      {line.retry && onRetry ? (
        <button type="button" className="ade-cx-cloud-update-retry" onClick={onRetry} disabled={retrying}>
          {retrying ? <CircleNotch size={11} className="animate-spin" aria-hidden /> : <ArrowClockwise size={11} weight="bold" aria-hidden />}
          Retry
        </button>
      ) : null}
    </span>
  );
}
