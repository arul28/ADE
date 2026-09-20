/**
 * Cursor's OAuth sign-in: the flow that opens a browser and mints an ADE key.
 * A hand-typed key is no longer a second surface here — every provider page
 * renders `ProviderApiKeysPanel`, and that panel is the one place a key is
 * entered, verified, replaced, or deleted.
 */
import React from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, SECTION_LABEL_STYLE, outlineButton } from "../../../lanes/laneDesignTokens";
import { CopyableCommand } from "../providerUi";
import type { ProvidersViewContext } from "../types";

/** Cursor account OAuth (email in the detail page) is not the same as a
 * verified ADE Cursor API key. The tile must not say "Sign in required"
 * when this is true. */
export function cursorOauthSignedIn(ctx: ProvidersViewContext): boolean {
  const connection = ctx.status?.providerConnections?.cursor ?? null;
  return Boolean(
    ctx.cursorAuth?.sdkStatus === "logged-in"
    || ctx.cursorAuth?.credentialSource === "cursor-oauth"
    || connection?.sources.some((entry) => entry.source === "cursor-oauth"),
  );
}

export function CursorAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  const connection = ctx.status?.providerConnections?.cursor ?? null;
  const isVerifying = ctx.verifyingProvider === "cursor";
  const signedInEmail = (ctx.cursorAuth?.email ?? connection?.accountEmail)?.trim() || null;
  const oauthSignedIn = cursorOauthSignedIn(ctx);
  const loginUrl = ctx.cursorLoginUrl ?? ctx.cursorAuth?.loginUrl ?? null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={SECTION_LABEL_STYLE}>Sign in with Cursor</div>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
        Opens a browser and mints a Cursor API key for ADE. Does not copy Cursor IDE cookies.
      </div>
      {oauthSignedIn ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: COLORS.success, fontSize: 11, fontFamily: SANS_FONT }}>
            <CheckCircle size={14} weight="fill" />
            {signedInEmail ? `Signed in as ${signedInEmail}` : "Signed in with Cursor"}
          </div>
          <button
            type="button"
            aria-label="Sign out of Cursor"
            style={{ ...outlineButton({ height: 28 }), color: COLORS.danger, alignSelf: "flex-start" }}
            disabled={ctx.cursorLoginBusy || isVerifying}
            onClick={() => void ctx.actions.logoutCursor()}
          >
            Sign out
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            aria-label="Sign in with Cursor"
            style={outlineButton({ height: 28 })}
            disabled={ctx.cursorLoginBusy || isVerifying}
            onClick={() => void ctx.actions.loginWithCursor()}
          >
            {ctx.cursorLoginBusy ? "Signing in…" : "Sign in"}
          </button>
          {ctx.cursorLoginBusy ? (
            <button
              type="button"
              aria-label="Cancel Cursor sign-in"
              style={outlineButton({ height: 28 })}
              onClick={() => void ctx.actions.cancelCursorLogin()}
            >
              Cancel
            </button>
          ) : null}
        </div>
      )}
      {loginUrl && ctx.cursorLoginBusy ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
            If a browser did not open, copy this URL:
          </div>
          <CopyableCommand command={loginUrl} />
        </div>
      ) : null}
    </section>
  );
}
