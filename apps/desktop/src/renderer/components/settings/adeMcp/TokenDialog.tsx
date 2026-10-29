/**
 * Make a token for ADE MCP, in two steps: name it and choose its access, then
 * copy it. The token lives only in this dialog's state: closing the dialog
 * unmounts it, so the token is gone from ADE and never shows on the page.
 */
import { useRef, useState } from "react";
import { Eye, Key, PencilSimple, ShieldCheck } from "@phosphor-icons/react";
import type { RemoteMcpCreatedToken, RemoteMcpScope } from "../../../../shared/types/remoteMcp";
import { Dialog } from "../../ui/dialog";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { ipcErrorMessage } from "../../../lib/format";
import { ADE_MCP_DIALOG_VARS, McpAppLogo, TOKEN_SNIPPETS, tokenSnippet, type TokenSnippetId } from "./adeMcpApps";
import { Snippet } from "./adeMcpParts";

const ACCESS: readonly { value: RemoteMcpScope; label: string; detail: string; icon: typeof PencilSimple }[] = [
  { value: "write", label: "Read & write", detail: "Works like you in ADE: start chats, make lanes, open PRs.", icon: PencilSimple },
  { value: "read", label: "Read only", detail: "Looks at lanes, chats, PRs and usage. Changes nothing.", icon: Eye },
];

export function TokenDialog({
  initialLabel = "",
  initialSnippet = "xai",
  serverUrl,
  createToken,
  onClose,
}: {
  initialLabel?: string;
  /** The app the dialog was opened from picks the snippet it opens on. */
  initialSnippet?: TokenSnippetId;
  serverUrl: string | null;
  createToken: (label: string, scope: RemoteMcpScope) => Promise<RemoteMcpCreatedToken>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [scope, setScope] = useState<RemoteMcpScope | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<RemoteMcpCreatedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [snippetId, setSnippetId] = useState<TokenSnippetId>(initialSnippet);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const asking = useRef(false);

  const submit = async () => {
    if (!scope || busy) return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await createToken(label.trim() || "Token", scope));
    } catch (err) {
      setError(ipcErrorMessage(err) || "ADE couldn't make a token.");
    } finally {
      setBusy(false);
    }
  };

  // Closing before the token was copied loses it for good: ask first.
  const requestClose = async () => {
    if (busy) return;
    if (!created || copied) {
      onClose();
      return;
    }
    if (asking.current) return;
    asking.current = true;
    try {
      const ok = await confirmDialog({
        title: "Close without copying the token?",
        message: "ADE shows a token only once. If you close now, revoke it under Connections and make a new one.",
        confirmLabel: "Close",
        cancelLabel: "Keep it open",
        tone: "warning",
      });
      if (ok) onClose();
    } finally {
      asking.current = false;
    }
  };

  const url = created?.serverUrl ?? serverUrl ?? "<server URL>";
  const snippet = tokenSnippet(snippetId);

  if (!created) {
    return (
      <Dialog
        open
        onOpenChange={(open) => { if (!open) void requestClose(); }}
        title="Make a token"
        description="For apps and scripts that send a header or an API key instead of signing in. It works on every computer you include."
        icon={<Key size={16} weight="duotone" />}
        tone="accent"
        size="md"
        panelClassName="ade-amcp-dialog"
        panelStyle={ADE_MCP_DIALOG_VARS}
        initialFocusRef={nameRef}
        dismissible={!busy}
        footerStart={scope ? null : <span className="ade-amcp-dialog-hint">Choose its access to continue.</span>}
        actions={[
          { label: busy ? "Making…" : "Make token", variant: "solid", onClick: () => void submit(), disabled: !scope, busy },
          { label: "Cancel", variant: "secondary", onClick: () => void requestClose(), disabled: busy },
        ]}
      >
        <form
          className="ade-amcp-token-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="ade-amcp-field">
            <span>Name</span>
            <input
              ref={nameRef}
              className="kit-input"
              value={label}
              maxLength={60}
              placeholder="e.g. Grok API or nightly script"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <div className="ade-amcp-field">
            <span id="ade-mcp-token-access">Access</span>
            <div className="ade-amcp-access" role="radiogroup" aria-labelledby="ade-mcp-token-access">
              {ACCESS.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={scope === option.value}
                    className="ade-amcp-access-choice"
                    onClick={() => setScope(option.value)}
                  >
                    <Icon size={16} weight={scope === option.value ? "fill" : "regular"} />
                    <span>
                      <b>{option.label}</b>
                      <small>{option.detail}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {error ? (
            <Banner layout="inline" model={{ id: "ade-mcp-token-error", tone: "error", title: error, report: { surface: "ade_mcp_token" } }} />
          ) : null}
          {/* Return in the name field submits. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) void requestClose(); }}
      title="Copy your token"
      description={`${created.connection.label} · ${created.connection.scope === "read" ? "Read only" : "Read & write"}. ADE shows it once; closing this forgets it.`}
      icon={<ShieldCheck size={16} weight="duotone" />}
      tone="success"
      width={600}
      panelClassName="ade-amcp-dialog"
      panelStyle={ADE_MCP_DIALOG_VARS}
      actions={[{ label: "I've copied it", variant: "solid", onClick: onClose, autoFocus: true }]}
      footerStart={copied ? <span className="ade-amcp-dialog-hint">Copied.</span> : <span className="ade-amcp-dialog-hint">Copy it before you close.</span>}
    >
      <div className="ade-amcp-token-step">
        <Snippet code={created.token} copyLabel="Copy token" caption="Token" secret onCopied={() => setCopied(true)} />
        <div className="ade-amcp-field">
          <span id="ade-mcp-token-use">Use it in</span>
          <div className="kit-seg ade-amcp-snippet-tabs" data-case="sentence" role="tablist" aria-labelledby="ade-mcp-token-use">
            {TOKEN_SNIPPETS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={option.id === snippetId}
                onClick={() => setSnippetId(option.id)}
              >
                <McpAppLogo app={option.logo} size={16} />
                {option.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="ade-amcp-snippet-panel">
            <p className="ade-amcp-snippet-where">{snippet.where}</p>
            <Snippet
              code={snippet.build(url, created.token)}
              copyLabel={`Copy ${snippet.label} snippet`}
              secret
              onCopied={() => setCopied(true)}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
