/**
 * A free-floating card describing one provider's install/auth state, with a
 * copyable command to fix it.
 *
 * "Free-floating" is the point: this is not slotted into the chat anywhere.
 * The host decides where a "Claude is not signed in" card belongs — a settings
 * page, an onboarding step, an empty state — so the component owns only its own
 * box and copy.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useAdeProviders } from "../context/AdeChatContext";
import type { AdeChatClient, ProviderStatus } from "../sdkTypes";

export type ProviderCardProps = {
  status: ProviderStatus;
  /** Replace the copy button (e.g. to open a terminal instead). */
  renderAction?: (command: string, kind: "install" | "login") => ReactNode;
  /** Override the clipboard write; defaults to `navigator.clipboard`. */
  onCopy?: (command: string) => void | Promise<void>;
  className?: string;
};

type ProviderState = "ready" | "unauthenticated" | "not_installed";

function resolveState(status: ProviderStatus): ProviderState {
  if (!status.installed) return "not_installed";
  if (!status.authenticated) return "unauthenticated";
  return "ready";
}

const STATE_COPY: Record<ProviderState, string> = {
  ready: "Ready",
  unauthenticated: "Not signed in",
  not_installed: "Not installed",
};

export function ProviderCard({ status, renderAction, onCopy, className }: ProviderCardProps) {
  const state = resolveState(status);
  const command =
    state === "not_installed"
      ? status.installCommand
      : state === "unauthenticated"
        ? status.loginCommand
        : undefined;
  const commandKind = state === "not_installed" ? "install" : "login";

  return (
    <div
      className={["adechat-providercard", className].filter(Boolean).join(" ")}
      data-state={state}
    >
      <div className="adechat-providercard-head">
        <span
          className="adechat-status-dot"
          data-status={state === "ready" ? "ok" : state === "unauthenticated" ? "unauthed" : "missing"}
          aria-hidden="true"
        />
        <span className="adechat-providercard-name">{status.displayName ?? status.id}</span>
        <span className="adechat-providercard-state">{STATE_COPY[state]}</span>
      </div>

      {status.detail ? <p className="adechat-providercard-detail">{status.detail}</p> : null}

      {command
        ? (renderAction?.(command, commandKind) ?? (
            <CopyableCommand command={command} {...(onCopy ? { onCopy } : {})} />
          ))
        : null}

      {status.docsUrl ? (
        <a
          className="adechat-providercard-detail"
          href={status.docsUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Documentation
        </a>
      ) : null}
    </div>
  );
}

function CopyableCommand({
  command,
  onCopy,
}: {
  command: string;
  onCopy?: (command: string) => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      if (onCopy) await onCopy(command);
      else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(command);
      } else return;
      setCopied(true);
    } catch {
      // Clipboard access can be denied (permissions, insecure context). The
      // command stays selectable, so the user is never stuck.
    }
  }, [command, onCopy]);

  return (
    <div className="adechat-command">
      <code className="adechat-command-text">{command}</code>
      <button type="button" className="adechat-button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export type ProviderCardsProps = {
  /** Supply statuses directly; omit to read from the client/context. */
  statuses?: readonly ProviderStatus[];
  client?: AdeChatClient;
  /** Show only providers that need attention. Default true. */
  onlyNeedsAttention?: boolean;
  renderAction?: ProviderCardProps["renderAction"];
  onCopy?: ProviderCardProps["onCopy"];
  className?: string;
};

/** Convenience list of the providers that need the user to do something. */
export function ProviderCards(props: ProviderCardsProps) {
  // Statuses passed in means no client is required at all, so the subscribing
  // hook must not run — hence the split rather than a conditional hook call.
  return props.statuses
    ? <ProviderCardsView {...props} statuses={props.statuses} />
    : <ConnectedProviderCards {...props} />;
}

function ConnectedProviderCards(props: ProviderCardsProps) {
  const connected = useAdeProviders(props.client);
  return <ProviderCardsView {...props} statuses={connected.statuses} />;
}

function ProviderCardsView({
  statuses = [],
  onlyNeedsAttention = true,
  renderAction,
  onCopy,
  className,
}: ProviderCardsProps) {
  const visible = onlyNeedsAttention
    ? statuses.filter((status) => resolveState(status) !== "ready")
    : statuses;

  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((status) => (
        <ProviderCard
          key={status.id}
          status={status}
          {...(renderAction ? { renderAction } : {})}
          {...(onCopy ? { onCopy } : {})}
          {...(className ? { className } : {})}
        />
      ))}
    </>
  );
}
