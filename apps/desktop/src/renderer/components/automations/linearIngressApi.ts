export type LinearIngressApi = typeof window.ade.automations.linearIngress;

/**
 * The Linear ingress IPC is part of the preload contract, but a remote runtime
 * on an older build may not expose it — probe defensively so callers degrade
 * (hide the row, fall back to a settings link) rather than throwing.
 */
export function linearIngressApi(): Partial<LinearIngressApi> | null {
  return window.ade?.automations?.linearIngress ?? null;
}
