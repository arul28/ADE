import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, CheckCircle, CircleNotch, Sparkle } from "@phosphor-icons/react";
import type { Agent37ClaudeTokenStatus } from "../../../shared/agent37";
import { SettingsTextField } from "./primitives";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { openExternalUrl } from "../../lib/openExternal";

/**
 * Settings › Integrations › Agent 37: Claude on cloud machines. The person
 * signs in once (Claude Code's own `claude setup-token`, run by this computer's
 * ADE in a private terminal); ADE keeps the token in the account and gives it
 * to every new Agent 37 machine, so a chat there, a ready machine's above all,
 * works without a sign-in step. Account-wide: no pin.
 */
export function Agent37ClaudeSignInCard() {
  const bridge = window.ade.agent37;
  const [status, setStatus] = useState<Agent37ClaudeTokenStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge?.claudeTokenStatus) return;
    try {
      setStatus(await bridge.claudeTokenStatus());
    } catch (loadError) {
      setError(ipcErrorMessage(loadError) || "Couldn't read your Claude sign-in for cloud machines.");
    }
  }, [bridge]);

  useEffect(() => {
    void load();
    const off = bridge?.onClaudeTokenChanged?.(() => { void load(); });
    return () => off?.();
  }, [bridge, load]);

  const run = async (action: () => Promise<Agent37ClaudeTokenStatus | null | undefined>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (actionError) {
      setError(ipcErrorMessage(actionError) || "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!bridge?.claudeTokenStatus) return null;
  const signIn = status?.signIn ?? null;
  const running = signIn?.state === "running" || signIn?.state === "saving";
  const saved = status?.saved === true;

  return (
    <IntegrationCard
      anchor="agent37-claude"
      icon={<Sparkle size={15} weight="fill" />}
      title="Claude on your cloud machines"
      badge={saved ? <span className="kit-tag" data-tone="ok">Signed in</span> : null}
      tone={running ? "focus" : undefined}
      hint="Sign in once. Every new Agent 37 machine then starts signed in to Claude, so a chat there works right away."
    >
      {running ? (
        <div className="ade-ig-form" style={{ marginTop: 6 }}>
          {signIn?.state === "saving" ? (
            <p className="ade-ig-note"><CircleNotch size={12} className="animate-spin" /> Saving to your ADE account…</p>
          ) : signIn?.awaitingCode ? (
            <>
              <p className="ade-ig-note">Paste the code the browser shows.</p>
              <div className="ade-ig-form-row">
                <SettingsTextField
                  value={code}
                  onChange={setCode}
                  placeholder="Code from the browser"
                  ariaLabel="Code from the browser"
                  mono
                  onKeyDown={(event) => { if (event.key === "Enter" && code.trim()) void run(async () => { const next = await bridge.claudeTokenSubmitCode?.(code); setCode(""); return next; }); }}
                />
                <button type="button" className="ade-modern-btn" data-tone="primary" disabled={busy || !code.trim()} onClick={() => void run(async () => { const next = await bridge.claudeTokenSubmitCode?.(code); setCode(""); return next; })}>
                  Continue
                </button>
              </div>
            </>
          ) : (
            <p className="ade-ig-note"><CircleNotch size={12} className="animate-spin" /> Finish signing in to Claude in your browser.</p>
          )}
          <div className="ade-ig-step-actions">
            {signIn?.url ? (
              <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => openExternalUrl(signIn.url!)}>
                <ArrowSquareOut size={12} /> Open the sign-in page
              </button>
            ) : null}
            <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy || signIn?.state === "saving"} onClick={() => void run(() => bridge.claudeTokenCancel!())}>
              Cancel
            </button>
          </div>
        </div>
      ) : saved ? (
        <div className="ade-ig-step-actions" style={{ marginTop: 6 }}>
          <p className="ade-ig-note" style={{ flex: 1 }}>
            <CheckCircle size={12} weight="fill" /> New machines get your Claude sign-in. Machines made before keep theirs.
          </p>
          <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void run(() => bridge.claudeTokenStart!())}>
            Sign in again
          </button>
          <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void run(() => bridge.claudeTokenRemove!())}>
            Remove
          </button>
        </div>
      ) : (
        <div className="ade-ig-step-actions" style={{ marginTop: 6 }}>
          <button type="button" className="ade-modern-btn" data-tone="primary" disabled={busy || !status} onClick={() => void run(() => bridge.claudeTokenStart!())}>
            {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
            Sign in with Claude
          </button>
        </div>
      )}
      {signIn?.state === "failed" && signIn.message && !running ? (
        <Banner layout="inline" model={{ id: "agent37-claude-failed", tone: "error", title: "Claude sign-in didn't finish", detail: signIn.message }} />
      ) : null}
      {status?.unknown ? (
        <Banner layout="inline" model={{ id: "agent37-claude-unknown", tone: "warning", title: "Couldn't read your ADE account", detail: "ADE can't tell if your Claude sign-in is saved. Check again in a moment.", actions: [{ label: "Check again", onClick: () => { void load(); } }] }} />
      ) : null}
      {error ? <Banner layout="inline" model={{ id: "agent37-claude-error", tone: "error", title: "Claude on cloud machines", detail: error }} /> : null}
    </IntegrationCard>
  );
}
