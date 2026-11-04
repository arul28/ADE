/**
 * The parts the agent-raised composer cards share: the connect card
 * (`IntegrationConnectCard.tsx`) and the MCP server card (`McpServerCard.tsx`).
 * Both take the composer's place with a branded banner ("Claude asks to …"),
 * one row of fields and a button, an error line under it, and a one-line
 * receipt in the transcript. Styles: `integrationConnectCard.css` (`ade-icc-*`).
 */
import React, { useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckCircle, Eye, EyeSlash, GearSix, Prohibit, X } from "@phosphor-icons/react";
import { isImeComposing } from "../../lib/imeComposition";
import { ProviderLogo } from "../shared/ProviderLogos";
import { Banner } from "../ui/notice";
import { ChatCard, ChatCardRow, ChatCardSub, ChatCardTitle } from "./chatCardPrimitives";
import "./integrationConnectCard.css";

/** One field on the card's row: a key (hidden, with Show), or plain text. */
export function CardFieldInput({
  kind,
  label,
  placeholder,
  title,
  value,
  onChange,
  onSubmit,
  disabled,
  autoFocus,
  testId,
}: {
  kind: "secret" | "text" | "url" | "email";
  label: string;
  placeholder: string;
  title?: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  autoFocus: boolean;
  testId: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const secret = kind === "secret";
  return (
    <span className="ade-icc-input" data-secret={secret ? "true" : undefined} title={title}>
      <input
        type={secret && !revealed ? "password" : kind === "email" ? "email" : "text"}
        aria-label={label}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete={secret ? "new-password" : kind === "email" ? "email" : "off"}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={placeholder}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
          event.preventDefault();
          onSubmit();
        }}
      />
      {secret ? (
        <button
          type="button"
          className="ade-icc-icon-button"
          disabled={disabled}
          aria-label={revealed ? "Hide" : "Show"}
          title={revealed ? "Hide" : "Show"}
          onClick={() => setRevealed((prev) => !prev)}
        >
          {revealed ? <EyeSlash size={13} /> : <Eye size={13} />}
        </button>
      ) : null}
    </span>
  );
}

/** "Claude asks to connect GitHub", with the asking agent's logo. */
export function CardHeading({
  askerFamily,
  asker,
  verb,
  title,
  mono = false,
}: {
  askerFamily: string;
  asker: string;
  verb: string;
  title: string;
  /** The title is a server name, not a brand. */
  mono?: boolean;
}) {
  return (
    <span className="ade-icc-heading">
      <span className="ade-icc-asker" title={asker}><ProviderLogo family={askerFamily} size={11} /></span>
      <span className="ade-icc-heading-text">
        <span className="ade-icc-heading-dim">{asker} {verb} </span>
        <span className={mono ? "ade-icc-title ade-mcpc-title-mono" : "ade-icc-title"}>{title}</span>
      </span>
    </span>
  );
}

/** The banner's last two buttons: the Settings page, and Not now. */
export function CardBannerButtons({
  onOpenSettings,
  onDecline,
  responding,
  testIdPrefix,
}: {
  onOpenSettings: () => void;
  onDecline: () => void;
  responding: boolean;
  testIdPrefix: string;
}) {
  return (
    <>
      <button
        type="button"
        className="ade-icc-close"
        title="Open in Settings"
        aria-label="Open in Settings"
        data-testid={`${testIdPrefix}-settings`}
        onClick={onOpenSettings}
      >
        <GearSix size={13} weight="bold" />
      </button>
      <button
        type="button"
        className="ade-icc-close"
        disabled={responding}
        title="Not now (Esc)"
        aria-label="Not now"
        data-testid={`${testIdPrefix}-decline`}
        onClick={onDecline}
      >
        <X size={13} weight="bold" />
      </button>
    </>
  );
}

/** Esc stops a running sign-in first; otherwise it says not now. */
export function cardEscapeHandler(args: {
  signingIn: boolean;
  cancelSignIn: () => void;
  responding: boolean;
  onDecline: () => void;
}) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event) || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (args.signingIn) args.cancelSignIn();
    else if (!args.responding) args.onDecline();
  };
}

/** Why the last answer did not go through: a refused key, a failed sign-in. The person fixes it. */
export function CardError({ id, message }: { id: string; message: string }) {
  return (
    <div data-testid={id}>
      <Banner layout="inline" model={{ id, tone: "error", title: message, report: false }} />
    </div>
  );
}

/** The card's line in the transcript: waiting, done, or not done. */
export function CardReceipt({
  testId,
  logo,
  state,
  name,
  before,
  after,
  sub,
}: {
  testId: string;
  logo: ReactNode;
  state: "open" | "done" | "not-done";
  name: string;
  /** Dim words before the name ("Connect "). */
  before?: string;
  /** Dim words after it ("connected with a token"). */
  after?: string;
  sub?: ReactNode;
}) {
  return (
    <ChatCard skin="line" data-testid={testId}>
      <ChatCardRow
        tone={state === "open" ? "running" : state === "done" ? "ok" : "idle"}
        {...(state === "open" ? { meta: "awaiting you" } : { icon: state === "done" ? CheckCircle : Prohibit })}
      >
        <ChatCardTitle>
          <span className="inline-flex items-center gap-1.5 align-middle">
            {logo}
            <span>
              {before ? <span className="font-normal text-fg/55">{before}</span> : null}
              {name}
              {after ? <span className="font-normal text-fg/55"> {after}</span> : null}
            </span>
          </span>
        </ChatCardTitle>
        {sub ? <ChatCardSub>{sub}</ChatCardSub> : null}
      </ChatCardRow>
    </ChatCard>
  );
}
