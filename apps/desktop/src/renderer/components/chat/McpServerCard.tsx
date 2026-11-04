import { useCallback, useState, type KeyboardEvent } from "react";
import { ArrowSquareOut, CheckCircle, Copy, Eye, EyeSlash, GearSix, LockKey, Plugs, Prohibit, SpinnerGap, Warning, X } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import { MCP_TRANSPORT_LABEL } from "../../../shared/mcpRegistry";
import { matchMcpCatalogue, mcpCatalogueEntry, type McpCatalogueEntry } from "../../../shared/mcpCatalogue";
import {
  MCP_SERVER_APPROVE_QUESTION_ID,
  MCP_SERVER_APPROVE_VALUE,
  mcpServerRequestAnswers,
  mcpServerRunsLabel,
  type McpServerRequestCard,
  type McpServerRequestSecret,
} from "../../../shared/mcpServerRequest";
import { ownQuestionValue } from "../../../shared/pendingInputAnswers";
import { cardAskerFamily, providerDisplayName } from "../../../shared/pendingInputLabels";
import { navigateToAppTarget } from "../../lib/openExternal";
import { isImeComposing } from "../../lib/imeComposition";
import { integrationThemeVars } from "../settings/integrations/integrationBrand";
import { MCP_ACCENT, mcpCatalogueBrand } from "../settings/mcp/mcpCatalogueBrand";
import { SolidLogo } from "../settings/providers/ProviderHero";
import { ProviderLogo } from "../shared/ProviderLogos";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { chatSettingsMachineId } from "./chatDeeplinks";
import { ChatCard, ChatCardRow, ChatCardSub, ChatCardTitle } from "./chatCardPrimitives";
import "../settings/providers/providerPage.css";
import "./integrationConnectCard.css";
import "./mcpServerCard.css";

function openUrl(url: string): void {
  void window.ade?.app?.openExternal?.(url);
}

/**
 * The MCP server card.
 *
 * An agent runs `ade mcp servers add <name> --reason …`. The card takes the
 * composer's place, the way the connect card does: the server's name, how it
 * connects, and one line with exactly what will execute (the command line,
 * "Runs") or be reached (the URL, "Connects to"), so the person approves what
 * they can read. A server in ADE's catalogue wears its brand and names its
 * publisher; any other server is marked Custom.
 * Values go back only as answers to `isSecret` questions; the host on the
 * chat's machine saves the server to the account and the values to the
 * account vault before the card closes. A save that fails keeps the card open
 * with the reason.
 */

function SecretFieldInput({
  secret,
  label,
  value,
  onChange,
  onSubmit,
  disabled,
  autoFocus,
}: {
  secret: McpServerRequestSecret;
  /** The catalogue's name for it ("API key"); absent: the variable or header name. */
  label: string | null;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  autoFocus: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="ade-icc-input" data-secret="true" title={`${secret.name} (${secret.field === "env" ? "env variable" : "header"})`}>
      <input
        type={revealed ? "text" : "password"}
        aria-label={label ?? secret.name}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="new-password"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={label ?? secret.name}
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
  );
}

function toolList(providers: readonly string[]): string {
  const names = providers.map(providerDisplayName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The catalogue entry a card's server is: the one it was built from, or the one its URL or package matches. */
export function cardCatalogueEntry(card: McpServerRequestCard): McpCatalogueEntry | null {
  return mcpCatalogueEntry(card.catalogueId) ?? matchMcpCatalogue(card.server);
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
  const entry = cardCatalogueEntry(card);
  const brand = entry ? mcpCatalogueBrand(entry) : null;
  const asked = card.secrets.filter((secret) => !secret.copied);
  const copied = card.secrets.filter((secret) => secret.copied);
  const [values, setValues] = useState<Record<string, string>>({});
  // A catalogue server that signs in through the browser: ADE signs in first,
  // on this computer, into the account vault, then adds it. The server finds
  // its sign-in already there on every machine.
  const signsIn = entry?.auth === "oauth" && server.transport !== "stdio" && Boolean(window.ade?.mcpRegistry?.signIn);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const busy = responding || signingIn;

  const add = useCallback(() => {
    if (busy) return;
    const answers: Record<string, string> = {};
    for (const secret of asked) answers[secret.questionId] = values[secret.questionId] ?? "";
    if (!signsIn) {
      onAdd(mcpServerRequestAnswers(answers));
      return;
    }
    setSigningIn(true);
    setSignInError(null);
    void window.ade.mcpRegistry!.signIn({ server })
      .then((result) => {
        if (result.ok) onAdd(mcpServerRequestAnswers(answers));
        else if (!("cancelled" in result && result.cancelled)) setSignInError(result.message);
      })
      .catch((signInFailure: unknown) => setSignInError(signInFailure instanceof Error ? signInFailure.message : "The sign-in did not finish."))
      .finally(() => setSigningIn(false));
  }, [asked, busy, onAdd, server, signsIn, values]);

  const cancelSignIn = useCallback(() => {
    void window.ade?.mcpRegistry?.cancelSignIn({ server: server.name });
  }, [server.name]);

  // The MCP servers page of the machine that runs this chat.
  const openSettings = useCallback(() => {
    navigateToAppTarget({ kind: "settings", entryId: "mcp.servers", machineId: chatSettingsMachineId(scope) });
  }, [scope]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (signingIn) cancelSignIn();
      else if (!responding) onDecline();
    }
  };

  const askerFamily = cardAskerFamily(request.source, chatProvider);
  const asker = providerDisplayName(askerFamily);
  const title = entry?.name ?? server.name;
  const savedTitle = `Saved to your account, on all your machines.${card.secrets.length ? " Values are never shown to the agent." : ""}`;
  const shownError = signInError ?? error;

  // With nothing to type, what runs and the button share one line.
  const inlineRuns = !asked.length && !copied.length;
  const runs = (
    <div className="ade-mcpc-runs" data-inline={inlineRuns || undefined} data-testid="mcp-server-runs">
      <span className="ade-mcpc-runs-label">{mcpServerRunsLabel(server)}</span>
      <code className="ade-mcpc-runs-line">{card.runs}</code>
      {card.source === "imported" && card.providers.length ? (
        <span className="ade-mcpc-from" title={`In ${toolList(card.providers)}'s settings on this computer`}>
          {card.providers.slice(0, 3).map((provider) => <ProviderLogo key={provider} family={provider} size={11} />)}
        </span>
      ) : null}
    </div>
  );
  return (
    <div
      role="group"
      aria-label={`${asker} asks to add the MCP server ${server.name}`}
      data-testid="mcp-server-composer"
      data-server={server.name}
      data-catalogue={entry?.id}
      data-ink={brand?.inkDark ? "dark" : undefined}
      className="ade-icc ade-mcpc"
      style={integrationThemeVars(brand?.accent ?? MCP_ACCENT)}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="ade-icc-banner ade-mcpc-banner" style={brand?.banner}>
        <span className="ade-icc-logo">
          {brand ? (
            <SolidLogo spec={{ ...brand.logo, size: 24 }} straight />
          ) : (
            <span className="ade-mcpc-tile" aria-hidden><Plugs size={17} weight="duotone" /></span>
          )}
        </span>
        <span className="ade-icc-heading">
          <span className="ade-icc-asker" title={asker}><ProviderLogo family={askerFamily} size={11} /></span>
          <span className="ade-icc-heading-text">
            <span className="ade-icc-heading-dim">{asker} asks to add </span>
            <span className={entry ? "ade-icc-title" : "ade-icc-title ade-mcpc-title-mono"}>{title}</span>
          </span>
        </span>
        <span className="ade-icc-banner-tools">
          {entry ? (
            <span className="ade-icc-chip" title={`${entry.publisher}'s own server, set up by ADE.`} data-testid="mcp-server-publisher">
              By {entry.publisher}
            </span>
          ) : (
            <span className="ade-icc-chip" title="A server ADE has no setup for. Check what it runs before you add it." data-testid="mcp-server-custom">
              Custom
            </span>
          )}
          <span className="ade-icc-chip" data-testid="mcp-server-transport">{MCP_TRANSPORT_LABEL[server.transport]}</span>
          <button
            type="button"
            className="ade-icc-close"
            title="Open in Settings"
            aria-label="Open in Settings"
            data-testid="mcp-server-settings"
            onClick={openSettings}
          >
            <GearSix size={13} weight="bold" />
          </button>
          <button
            type="button"
            className="ade-icc-close"
            disabled={responding}
            title="Not now (Esc)"
            aria-label="Not now"
            data-testid="mcp-server-decline"
            onClick={onDecline}
          >
            <X size={13} weight="bold" />
          </button>
        </span>
      </div>

      <div className="ade-icc-body">
        {card.reason ? <p className="ade-icc-reason">{card.reason}</p> : null}

        {inlineRuns ? null : runs}

        <div className="ade-icc-row" data-fields={asked.length}>
          {inlineRuns ? runs : null}
          {asked.length ? (
            <span className="ade-icc-fields" title={savedTitle}>
              {asked.map((secret, index) => (
                <SecretFieldInput
                  key={secret.questionId}
                  secret={secret}
                  label={entry?.secrets?.find((candidate) => candidate.name === secret.name)?.label ?? null}
                  value={values[secret.questionId] ?? ""}
                  onChange={(next) => setValues((prev) => ({ ...prev, [secret.questionId]: next }))}
                  onSubmit={add}
                  disabled={busy}
                  autoFocus={index === 0}
                />
              ))}
            </span>
          ) : null}
          {copied.length ? (
            <span className="ade-icc-chip ade-mcpc-copied" title={`Copied from ${card.providers.length ? toolList(card.providers) : "the other tool"}'s settings into your account vault.`}>
              <Copy size={11} weight="bold" /> {copied.map((secret) => secret.name).join(", ")} copied
            </span>
          ) : null}
          {asked.length && entry?.tokenUrl ? (
            <button type="button" className="ade-icc-link" onClick={() => openUrl(entry.tokenUrl!)}>
              Get a key
              <ArrowSquareOut size={10} weight="bold" />
            </button>
          ) : null}
          {!asked.length && !inlineRuns ? <span className="ade-mcpc-spacer" /> : null}
          {signingIn ? (
            <button type="button" className="ade-icc-link ade-icc-link-dim" onClick={cancelSignIn}>Cancel</button>
          ) : null}
          <button
            type="button"
            className={signsIn ? "ade-icc-primary ade-icc-primary-brand" : "ade-icc-primary"}
            disabled={busy}
            autoFocus={!asked.length}
            title={savedTitle}
            data-testid="mcp-server-add"
            onClick={add}
          >
            {busy ? (
              <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin" />
            ) : signsIn && brand ? (
              <span className="ade-icc-primary-mark" aria-hidden>{brand.logo.mark(13)}</span>
            ) : (
              <LockKey size={12} weight="bold" />
            )}
            {signingIn ? "Waiting for the browser…" : responding ? "Adding…" : signsIn ? `Continue with ${title}` : "Add server"}
          </button>
        </div>

        {shownError ? (
          <div className="ade-icc-error" role="alert" data-testid="mcp-server-error">
            <Warning size={13} weight="fill" />
            <span>{shownError}</span>
          </div>
        ) : null}
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
  const entry = cardCatalogueEntry(card);
  const brand = entry ? mcpCatalogueBrand(entry) : null;
  const logo = brand ? (
    <span className="ade-mcpc-receipt-logo" style={{ ...brand.banner, color: brand.logo.face }} aria-hidden>
      {brand.logo.mark(11)}
    </span>
  ) : (
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
