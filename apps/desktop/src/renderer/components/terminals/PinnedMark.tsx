import { PushPin } from "@phosphor-icons/react";
import { SESSION_PINNED_TOOLTIP } from "./sessionLifecycleActions";

/** The pin on a pinned chat's row, with a tooltip that says what a pin does. */
export function PinnedMark() {
  return (
    <span className="inline-flex shrink-0" title={SESSION_PINNED_TOOLTIP}>
      <PushPin size={11} weight="fill" aria-label="Pinned" className="shrink-0 text-muted-fg/55" />
    </span>
  );
}
