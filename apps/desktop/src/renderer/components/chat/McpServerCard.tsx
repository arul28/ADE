import { useCallback, useState, type KeyboardEvent } from "react";
import { CheckCircle, Copy, Eye, EyeSlash, GearSix, LockKey, Plugs, Prohibit, SpinnerGap, Warning, X } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import { MCP_TRANSPORT_LABEL } from "../../../shared/mcpRegistry";
import {
  MCP_SERVER_APPROVE_QUESTION_ID,
  MCP_SERVER_APPROVE_VALUE,
  mcpServerRequestAnswers,
  type McpServerRequestCard,
  type McpServerRequestSecret,
} from "../../../shared/mcpServerRequest";
import { ownQuestionValue } from "../../../shared/pendingInputAnswers";
import { cardAskerFamily, providerDisplayName } from "../../../shared/pendingInputLabels";
import { navigateToAppTarget } from "../../lib/openExternal";
import { isImeComposing } from "../../lib/imeComposition";
import { integrationThemeVars } from "../settings/integrations/integrationBrand";
import { ProviderLogo } from "../shared/ProviderLogos";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { chatSettingsMachineId } from "./chatDeeplinks";
import { ChatCard, ChatCardRow, ChatCardSub, ChatCardTitle } from "./chatCardPrimitives";
import "./integrationConnectCard.css";
import "./mcpServerCard.css";

/**
 * The MCP server card.
 *
 * An agent runs `ade mcp servers add <name> --reason …`. The card takes the
 * composer's place, the way the connect card does: the server's name, how it
 * connects, and a **Runs:** line with exactly what will execute (the command
 * line) or be dialed (the URL), so the person approves what they can read.
 * Values go back only as answers to `isSecret` questions; the host on the
 * chat's machine saves the server to the account and the values to the
 * account vault before the card closes. A save that fails keeps the card open
 * with the reason.
 */

/** MCP's own violet, so the card reads as the MCP servers page it saves into. */
const MCP_ACCENT = "#8b7cf6";

const SAVED_WHERE = "Saved to your account, on all your machines.";

function SecretFieldInput({
  secret,
  value,
  onChange,
  onSubmit,
  disabled,
  autoFocus,
}: {
  secret: McpServerRequestSecret;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  autoFocus: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <label className="ade-icc-field" data-secret="true">
      <span className="ade-icc-field-label ade-mcpc-field-label">
        <span className="ade-mcpc-field-name">{secret.name}</span>
        <span className="ade-mcpc-field-kind">{secret.field === "env" ? "env" : "header"}</span>
      </span>
      <span className="ade-icc-input">
        <input
          type={revealed ? "text" : "password"}
          aria-label={secret.name}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Leave empty to add it later in Settings"
          data-testid={`mcp-server-field-${secret.questionId}`}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
            event.preventDefault();
            onSubmit();
          }}
        />
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
      </span>
    </label>
  );
}

function toolList(providers: readonly string[]): string {
  const names = providers.map(providerDisplayName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The agent-raised card, in the composer's place. Enter adds the server, Esc
 * says not now.
 */
export function McpServerRequestComposer({
  request,
  card,
  responding,
  error,
  onAdd,
  onDecline,
  chatProvider,
}: {
  request: PendingInputRequest;
  card: McpServerRequestCard;
  responding: boolean;
  /** Why the last answer did not save, from the host. */
  error: string | null;
  onAdd: (answers: Record<string, string>) => void;
  onDecline: () => void;
  /** The chat's provider: the agent that ran the command, which the card names. */
  chatProvider?: string | null;
}) {
  const scope = useChatRuntimeScope();
  const { server } = card;
  const asked = card.secrets.filter((secret) => !secret.copied);
  const copied = card.secrets.filter((secret) => secret.copied);
  const [values, setValues] = useState<Record<string, string>>({});

  const add = useCallback(() => {
    if (responding) return;
    const answers: Record<string, string> = {};
    for (const secret of asked) answers[secret.questionId] = values[secret.questionId] ?? "";
    onAdd(mcpServerRequestAnswers(answers));
  }, [asked, onAdd, responding, values]);

  // The MCP servers page of the machine that runs this chat.
  const openSettings = useCallback(() => {
    navigateToAppTarget({ kind: "settings", entryId: "mcp.servers", machineId: chatSettingsMachineId(scope) });
  }, [scope]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape" && !responding) {
      event.preventDefault();
      event.stopPropagation();
      onDecline();
    }
  };

  const askerFamily = cardAskerFamily(request.source, chatProvider);
  const asker = providerDisplayName(askerFamily);

  return (
    <div
      role="group"
      aria-label={`${asker} asks to add the MCP server ${server.name}`}
      data-testid="mcp-server-composer"
      data-server={server.name}
      className="ade-icc ade-mcpc"
      style={integrationThemeVars(MCP_ACCENT)}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="ade-mcpc-head">
        <span className="ade-mcpc-tile" aria-hidden><Plugs size={20} weight="duotone" /></span>
        <div className="ade-mcpc-id">
          <span className="ade-icc-eyebrow">
            <span className="ade-icc-asker"><ProviderLogo family={askerFamily} size={11} /></span>
            {asker} asks to add an MCP server
          </span>
          <span className="ade-mcpc-title-row">
            <span className="ade-mcpc-title">{server.name}</span>
            <span className="ade-mcpc-chip" data-testid="mcp-server-transport">{MCP_TRANSPORT_LABEL[server.transport]}</span>
            {card.source === "imported" && card.providers.length ? (
              <span className="ade-mcpc-chip ade-mcpc-chip-quiet" title={`In ${toolList(card.providers)}'s settings on this computer`}>
                {card.providers.slice(0, 3).map((provider) => <ProviderLogo key={provider} family={provider} size={10} />)}
                From {toolList(card.providers)}
              </span>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          className="ade-icc-close ade-mcpc-close"
          disabled={responding}
          title="Not now (Esc)"
          aria-label="Not now"
          data-testid="mcp-server-decline-x"
          onClick={onDecline}
        >
          <X size={13} weight="bold" />
        </button>
      </div>

      <div className="ade-icc-body">
        {card.reason ? <p className="ade-icc-reason">{card.reason}</p> : null}

        <div className="ade-mcpc-runs" data-testid="mcp-server-runs">
          <span className="ade-mcpc-runs-label">Runs:</span>
          <code className="ade-mcpc-runs-line">{card.runs}</code>
        </div>

        {asked.length ? (
          <div className="ade-icc-form">
            <div className="ade-icc-fields ade-mcpc-fields">
              {asked.map((secret, index) => (
                <SecretFieldInput
                  key={secret.questionId}
                  secret={secret}
                  value={values[secret.questionId] ?? ""}
                  onChange={(next) => setValues((prev) => ({ ...prev, [secret.questionId]: next }))}
                  onSubmit={add}
                  disabled={responding}
                  autoFocus={index === 0}
                />
              ))}
            </div>
          </div>
        ) : null}

        {copied.length ? (
          <div className="ade-icc-note ade-mcpc-copied">
            <Copy size={11} weight="bold" />
            <span>
              {copied.map((secret) => secret.name).join(", ")} {copied.length === 1 ? "is" : "are"} copied from
              {" "}{card.providers.length ? toolList(card.providers) : "the other tool"}'s settings into your account vault.
            </span>
          </div>
        ) : null}

        <div className="ade-icc-form-row">
          <div className="ade-icc-hint">
            Every chat ADE starts gets its tools. A chat that is already running gets them after Refresh chat.
          </div>
          <button
            type="button"
            className="ade-icc-primary"
            disabled={responding}
            autoFocus={!asked.length}
            data-testid="mcp-server-add"
            onClick={add}
          >
            {responding ? <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" /> : null}
            {responding ? "Adding…" : "Add server"}
          </button>
        </div>

        {error ? (
          <div className="ade-icc-error" role="alert" data-testid="mcp-server-error">
            <Warning size={13} weight="fill" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>

      <div className="ade-icc-foot">
        <span className="ade-icc-saved">
          <LockKey size={11} weight="bold" />
          {SAVED_WHERE}{card.secrets.length ? " Values are never shown to the agent." : ""}
        </span>
        <span className="ade-icc-foot-actions">
          <button type="button" className="ade-icc-quiet" onClick={openSettings} data-testid="mcp-server-settings">
            <GearSix size={12} />
            Open in Settings
          </button>
          <button
            type="button"
            className="ade-icc-quiet"
            disabled={responding}
            data-testid="mcp-server-decline"
            onClick={onDecline}
          >
            Not now
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The transcript record: one line while the card waits, then the receipt.
 * Built from the definition and the approval alone; no value reached the event.
 */
export function McpServerRequestReceipt({
  card,
  resolution,
  answers,
}: {
  card: McpServerRequestCard;
  resolution: "accepted" | "declined" | "cancelled" | null;
  answers?: Record<string, string | string[]> | undefined;
}) {
  const logo = (
    <span className="ade-mcpc-receipt-logo" aria-hidden>
      <Plugs size={11} weight="bold" />
    </span>
  );
  if (resolution === null) {
    return (
      <ChatCard skin="line" data-testid="mcp-server-receipt-open">
        <ChatCardRow tone="running" meta="awaiting you">
          <ChatCardTitle>
            <span className="inline-flex items-center gap-1.5 align-middle">
              {logo}
              <span><span className="font-normal text-fg/55">Add MCP server </span>{card.server.name}</span>
            </span>
          </ChatCardTitle>
        </ChatCardRow>
      </ChatCard>
    );
  }
  const raw = ownQuestionValue(answers, MCP_SERVER_APPROVE_QUESTION_ID);
  const approval = Array.isArray(raw) ? raw[0] : raw;
  // A client that answers the questions can pick "Not now" and still accept.
  const added = resolution === "accepted" && (approval == null || approval === MCP_SERVER_APPROVE_VALUE);
  const text = added
    ? "added to your MCP servers · on all your machines"
    : resolution === "cancelled" ? "· closed before it was answered" : "· not now";
  return (
    <ChatCard skin="line" data-testid="mcp-server-receipt">
      <ChatCardRow tone={added ? "ok" : "idle"} icon={added ? CheckCircle : Prohibit}>
        <ChatCardTitle>
          <span className="inline-flex items-center gap-1.5 align-middle">
            {logo}
            <span>{card.server.name}<span className="font-normal text-fg/55"> {text}</span></span>
          </span>
        </ChatCardTitle>
        <ChatCardSub><span className="font-mono">{card.runs}</span></ChatCardSub>
      </ChatCardRow>
    </ChatCard>
  );
}
