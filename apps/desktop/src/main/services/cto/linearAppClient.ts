/**
 * The ADE Linear OAuth application ("ADE" in Linear's OAuth app directory).
 *
 * The client id is public by design — it appears in every user's authorize
 * URL. Sign-in uses PKCE (the loopback flow already falls back to PKCE when
 * no client secret is configured), so no client secret ships with the app.
 *
 * Workspaces that authorize this app get their Linear webhook auto-created by
 * Linear itself (the app's webhook config points at the ADE relay), which is
 * why app-connected projects skip the manual "Connect Linear events" step.
 * Data-change webhook delivery requires the authorization to carry the
 * `admin` scope — Linear's rule for OAuth-app webhooks.
 */
export const ADE_LINEAR_APP_CLIENT_ID = "e552c738cd63ea5967f08bbc9c09b54c";

export type LinearOAuthClientSource = "ade-app" | "custom";
