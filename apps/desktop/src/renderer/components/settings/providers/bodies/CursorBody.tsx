/**
 * Cursor's two peers: the OAuth sign-in that mints an ADE key, and a key typed
 * in by hand. Neither is the "real" one — Cursor users arrive with either.
 */
import React from "react";
import { CheckCircle, Info, XCircle } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, SECTION_LABEL_STYLE, outlineButton } from "../../../lanes/laneDesignTokens";
import { ConnectedTag } from "../../providerSectionPrimitives";
import { CopyableCommand, SourceBadge } from "../providerUi";
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

function cursorKeyState(ctx: ProvidersViewContext) {
  const connection = ctx.status?.providerConnections?.cursor ?? null;
  const keySource = ctx.apiKeySources.get("cursor")
    ?? (ctx.storedProviders.includes("cursor") ? ("store" as const) : undefined);
  const verification = ctx.verificationByProvider.cursor;
  const isVerifying = ctx.verifyingProvider === "cursor";
  const isVerified = !isVerifying && verification?.ok;
  const isInvalid = !isVerifying && verification && !verification.ok;
  return {
    connection,
    keySource,
    verification,
    isVerifying,
    isVerified,
    isInvalid,
    isEditing: ctx.editingProvider === "cursor",
    isKeyConnected: Boolean(isVerified || (!isInvalid && keySource && connection?.runtimeAvailable)),
  };
}

export function CursorAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  const { connection, isVerifying } = cursorKeyState(ctx);
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

export function CursorBody({ ctx }: { ctx: ProvidersViewContext }) {
  const { keySource, verification, isVerifying, isEditing, isKeyConnected } = cursorKeyState(ctx);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={SECTION_LABEL_STYLE}>API key</div>
      <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>CURSOR_API_KEY</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          {isEditing ? (
            <input
              autoFocus
              aria-label="Cursor API key"
              value={ctx.editValue}
              onChange={(event) => ctx.actions.setEditValue(event.target.value)}
              placeholder="crsr_..."
              type="password"
              disabled={isVerifying}
              style={{ width: "100%", background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }}
            />
          ) : keySource ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <SourceBadge source={keySource} />
              {isVerifying ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: COLORS.info, fontSize: 10, fontFamily: SANS_FONT }}>
                  <Info size={12} weight="fill" />
                  Verifying...
                </span>
              ) : isKeyConnected ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: COLORS.success, fontSize: 10, fontFamily: SANS_FONT }}>
                  <CheckCircle size={12} weight="fill" />
                  Connected
                </span>
              ) : verification ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: verification.ok ? COLORS.success : COLORS.danger, fontSize: 10, fontFamily: SANS_FONT }}>
                  {verification.ok ? <CheckCircle size={12} weight="fill" /> : <XCircle size={12} weight="fill" />}
                  {verification.ok ? "Verified" : verification.message}
                </span>
              ) : (
                <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                  {keySource === "env" ? "Loaded from environment" : keySource === "config" ? "Defined in project config" : "Stored locally"}
                </span>
              )}
            </div>
          ) : (
            <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>No Cursor API key configured</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {isEditing ? (
            <>
              <button
                type="button"
                aria-label="Save Cursor API key"
                style={outlineButton({ height: 28 })}
                disabled={isVerifying || !ctx.editValue.trim()}
                onClick={() => void ctx.actions.saveCursorApiKey()}
              >
                {isVerifying ? "Verifying..." : "Save"}
              </button>
              <button type="button" style={outlineButton({ height: 28 })} disabled={isVerifying} onClick={ctx.actions.cancelEditing}>Cancel</button>
            </>
          ) : keySource ? (
            <>
              {isKeyConnected ? (
                <ConnectedTag />
              ) : (
                <button
                  type="button"
                  aria-label="Verify Cursor API key"
                  style={outlineButton({ height: 28 })}
                  disabled={isVerifying}
                  onClick={() => void ctx.actions.verifyApiKey("cursor")}
                >
                  {isVerifying ? "Verifying..." : "Verify"}
                </button>
              )}
              {keySource === "store" ? (
                <>
                  <button type="button" style={outlineButton({ height: 28 })} disabled={isVerifying} onClick={() => ctx.actions.beginEditing("cursor")}>Replace</button>
                  <button type="button" style={outlineButton({ height: 28 })} disabled={isVerifying} onClick={() => void ctx.actions.deleteApiKey("cursor").catch(() => undefined)}>Delete</button>
                </>
              ) : null}
            </>
          ) : (
            <button type="button" aria-label="Add Cursor API key" style={outlineButton({ height: 28 })} onClick={() => ctx.actions.beginEditing("cursor")}>Add key</button>
          )}
        </div>
      </div>
    </section>
  );
}
