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
