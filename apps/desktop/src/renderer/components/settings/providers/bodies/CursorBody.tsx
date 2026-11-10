/**
 * Cursor's OAuth sign-in: the flow that opens a browser and mints an ADE key.
 * A hand-typed key is no longer a second surface here — every provider page
 * renders `ProviderApiKeysPanel`, and that panel is the one place a key is
 * entered, verified, replaced, or deleted.
 *
 * The flow is the page's (`loginWithCursor`, `cancelCursorLogin` on the
 * page's pin); "Sign in" also opens the shared sign-in sheet, which shows it.
 */
import React, { useCallback, useRef, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, SECTION_LABEL_STYLE, outlineButton } from "../../../lanes/laneDesignTokens";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { CursorSignInSheetView, type CursorSignInOutcome } from "../ProviderSignInSheet";
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
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const connection = ctx.status?.providerConnections?.cursor ?? null;
  const isVerifying = ctx.verifyingProvider === "cursor";
  const signedInEmail = (ctx.cursorAuth?.email ?? connection?.accountEmail)?.trim() || null;
  const oauthSignedIn = cursorOauthSignedIn(ctx);
  const loginUrl = ctx.cursorLoginUrl ?? ctx.cursorAuth?.loginUrl ?? null;
  const loginWithCursor = ctx.actions.loginWithCursor;
  const cancelCursorLogin = ctx.actions.cancelCursorLogin;
  /** The sheet is up. `expected` is the account Cursor named before; `watching` is a sign-in this sheet did not start. */
  const [sheet, setSheet] = useState<{ expected: string | null; watching: boolean } | null>(null);
  const [outcome, setOutcome] = useState<CursorSignInOutcome | null>(null);
  const attemptRef = useRef(0);

  const start = useCallback((expected: string | null) => {
    const attempt = ++attemptRef.current;
    setOutcome(null);
    setSheet({ expected, watching: false });
    void loginWithCursor().then((result) => {
      // A later attempt, or a closed sheet, owns what is on screen now.
      if (attemptRef.current === attempt) setOutcome(result);
    });
  }, [loginWithCursor]);

  // A sign-in this sheet only watches (one already running when the page
  // opened) ends when the page's Cursor feed says so.
  const shownOutcome: CursorSignInOutcome | null = outcome
    ?? (sheet?.watching && !ctx.cursorLoginBusy && !isVerifying
      ? oauthSignedIn
        ? { ok: true, email: signedInEmail }
        : { ok: false, error: "The sign-in ended without a Cursor login." }
      : null);

  const closeSheet = useCallback(() => {
    attemptRef.current += 1;
    // Closing mid-flow stops the sign-in on the page's machine.
    if (ctx.cursorLoginBusy && !shownOutcome) void cancelCursorLogin();
    setSheet(null);
    setOutcome(null);
  }, [cancelCursorLogin, ctx.cursorLoginBusy, shownOutcome]);

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
            disabled={isVerifying}
            onClick={() => (ctx.cursorLoginBusy ? setSheet({ expected: signedInEmail, watching: true }) : start(signedInEmail))}
          >
            {ctx.cursorLoginBusy ? "Signing in…" : "Sign in"}
          </button>
          {ctx.cursorLoginBusy ? (
            <button
              type="button"
              aria-label="Cancel Cursor sign-in"
              style={outlineButton({ height: 28 })}
              onClick={() => void cancelCursorLogin()}
            >
              Cancel
            </button>
          ) : null}
        </div>
      )}
      {sheet ? (
        <CursorSignInSheetView
          running={ctx.cursorLoginBusy}
          verifying={isVerifying}
          loginUrl={loginUrl}
          outcome={shownOutcome}
          expectedAccount={sheet.expected}
          machine={{ pin, isThisMachine, machineName }}
          onClose={closeSheet}
          onTryAgain={() => start(sheet.expected)}
        />
      ) : null}
    </section>
  );
}
