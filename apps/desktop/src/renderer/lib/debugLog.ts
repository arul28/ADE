type RendererDebugPayload = Record<string, unknown>;

export function logRendererDebugEvent(
  event: string,
  payload: RendererDebugPayload = {},
): void {
  const adeWindow = window as Window & {
    ade?: {
      app?: {
        logDebugEvent?: (event: string, payload?: RendererDebugPayload) => void;
      };
    };
  };
  const logDebugEvent = adeWindow.ade?.app?.logDebugEvent;
  if (typeof logDebugEvent !== "function") return;
  try {
    logDebugEvent(event, payload);
  } catch {
    // Renderer debug breadcrumbs must never affect app behavior.
  }
}

const bootMarks = new Set<string>();

/**
 * A launch timing mark, `ade:boot:<name>`, once per window. Diagnostics only:
 * the launch check reads these marks over the devtools protocol.
 */
export function markBoot(name: string): void {
  if (bootMarks.has(name)) return;
  bootMarks.add(name);
  try {
    performance.mark(`ade:boot:${name}`);
  } catch {
    // best effort
  }
}
