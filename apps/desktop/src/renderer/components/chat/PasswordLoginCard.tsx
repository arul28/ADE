import { useCallback, useState } from "react";
import { Browser, Key, LockKey, SpinnerGap } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import {
  PASSWORD_LOGIN_CHOICE_QUESTION_ID,
  PASSWORD_LOGIN_PASSWORD_QUESTION_ID,
  PASSWORD_LOGIN_USERNAME_QUESTION_ID,
  PASSWORD_LOGIN_WHERE_IT_GOES,
  type PasswordLoginRequestCard,
} from "../../../shared/passwordLoginRequest";
import { ownQuestionValue } from "../../../shared/pendingInputAnswers";
import { cardAskerFamily, providerDisplayName } from "../../../shared/pendingInputLabels";
import { navigateToAppTarget } from "../../lib/openExternal";
import { integrationThemeVars } from "../settings/integrations/integrationBrand";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { chatSettingsMachineId } from "./chatDeeplinks";
import { CardBannerButtons, CardError, CardFieldInput, CardHeading, CardReceipt, cardEscapeHandler } from "./composerCardParts";

/**
 * The secure sign-in card.
 *
 * An agent's `ade browser signin` found no saved login for the page's site.
 * The card takes the composer's place and names the exact site it fills. The
 * first move is always saving: **Save & sign in** puts the username and
 * password in Passwords, then the agent's sign-in fills the page. **Enter it
 * myself in the browser** leaves the page to the person; ADE offers to save
 * what they type. The values go back only as answers to `isSecret` questions,
 * so they never reach the transcript or the agent.
 */

const PASSWORDS_ACCENT = "#5b6cff";

export function passwordLoginSaveAnswers(username: string, password: string): Record<string, string> {
  return {
    [PASSWORD_LOGIN_CHOICE_QUESTION_ID]: "save",
    [PASSWORD_LOGIN_USERNAME_QUESTION_ID]: username,
    [PASSWORD_LOGIN_PASSWORD_QUESTION_ID]: password,
  };
}

export function passwordLoginSelfAnswers(): Record<string, string> {
  return { [PASSWORD_LOGIN_CHOICE_QUESTION_ID]: "self" };
}

export function PasswordLoginRequestComposer({
  request,
  card,
  responding,
  error,
  onSave,
  onSelf,
  onDecline,
  chatProvider,
}: {
  request: PendingInputRequest;
  card: PasswordLoginRequestCard;
  responding: boolean;
  /** Why the last answer did not save, from the host. */
  error: string | null;
  onSave: (answers: Record<string, string>) => void;
  onSelf: () => void;
  onDecline: () => void;
  chatProvider?: string | null;
}) {
  const scope = useChatRuntimeScope();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [missing, setMissing] = useState(false);

  const save = useCallback(() => {
    if (responding) return;
    if (!password) {
      setMissing(true);
      return;
    }
    onSave(passwordLoginSaveAnswers(username.trim(), password));
    // The values went with the answer; this card keeps nothing.
    setPassword("");
  }, [onSave, password, responding, username]);

  const openSettings = useCallback(() => {
    navigateToAppTarget({ kind: "settings", entryId: "passwords.logins", machineId: chatSettingsMachineId(scope) });
  }, [scope]);

  const onKeyDown = cardEscapeHandler({ responding, onDecline });
  const askerFamily = cardAskerFamily(request.source, chatProvider);
  const asker = providerDisplayName(askerFamily);
  const whereItGoes = PASSWORD_LOGIN_WHERE_IT_GOES(card.site);
  const shownError = missing && !password ? "Enter the password, or enter it yourself in the browser." : error;

  return (
    <div
      role="group"
      aria-label={`${asker} asks to sign in to ${card.site}`}
      data-testid="password-login-composer"
      data-site={card.site}
      className="ade-icc"
      style={integrationThemeVars(PASSWORDS_ACCENT)}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="ade-icc-banner">
        <span className="ade-icc-logo" aria-hidden><Key size={20} weight="duotone" /></span>
        <CardHeading askerFamily={askerFamily} asker={asker} verb="asks to sign in to" title={card.site} />
        <span className="ade-icc-banner-tools">
          <span className="ade-icc-chip" title={card.origin} data-testid="password-login-origin">{card.origin.replace(/^https:\/\//, "")}</span>
          <CardBannerButtons onOpenSettings={openSettings} onDecline={onDecline} responding={responding} testIdPrefix="password-login" />
        </span>
      </div>

      <div className="ade-icc-body">
        {card.reason ? <p className="ade-icc-reason">{card.reason}</p> : null}
        <p className="ade-icc-reason" data-testid="password-login-where">{whereItGoes}</p>
        <div className="ade-icc-row" data-fields={2}>
          <span className="ade-icc-fields" title={whereItGoes}>
            <CardFieldInput
              kind="email"
              label="Username or email"
              placeholder="Username or email"
              value={username}
              onChange={setUsername}
              onSubmit={save}
              disabled={responding}
              autoFocus
              testId="password-login-username"
            />
            <CardFieldInput
              kind="secret"
              label="Password"
              placeholder="Password"
              value={password}
              onChange={(next) => {
                setPassword(next);
                setMissing(false);
              }}
              onSubmit={save}
              disabled={responding}
              autoFocus={false}
              testId="password-login-password"
            />
          </span>
          <button
            type="button"
            className="ade-icc-link"
            disabled={responding}
            data-testid="password-login-self"
            onClick={onSelf}
          >
            <Browser size={11} weight="bold" />
            Enter it myself in the browser
          </button>
          <button
            type="button"
            className="ade-icc-primary"
            disabled={responding}
            title={whereItGoes}
            data-testid="password-login-save"
            onClick={save}
          >
            {responding ? <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" /> : <LockKey size={12} weight="bold" />}
            {responding ? "Saving…" : "Save & sign in"}
          </button>
        </div>
        {shownError ? <CardError id="password-login-error" message={shownError} /> : null}
      </div>
    </div>
  );
}

/** The transcript record: the site and the outcome only; no value reached the event. */
export function PasswordLoginRequestReceipt({
  card,
  resolution,
  answers,
}: {
  card: PasswordLoginRequestCard;
  resolution: "accepted" | "declined" | "cancelled" | null;
  answers?: Record<string, string | string[]> | undefined;
}) {
  const logo = (
    <span className="ade-icc-receipt-logo" aria-hidden>
      <Key size={11} weight="bold" />
    </span>
  );
  if (resolution === null) {
    return <CardReceipt testId="password-login-receipt-open" logo={logo} state="open" before="Sign in to " name={card.site} />;
  }
  const raw = ownQuestionValue(answers, PASSWORD_LOGIN_CHOICE_QUESTION_ID);
  const choice = Array.isArray(raw) ? raw[0] : raw;
  const accepted = resolution === "accepted";
  const text = !accepted
    ? resolution === "cancelled" ? "· closed before it was answered" : "· not now"
    : choice === "self" ? "· you signed in in the browser" : "· saved to Passwords";
  return (
    <CardReceipt
      testId="password-login-receipt"
      logo={logo}
      state={accepted ? "done" : "not-done"}
      name={card.site}
      before="Sign in to "
      after={text}
    />
  );
}
