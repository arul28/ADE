import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CheckCircle, CircleNotch, Key } from "@phosphor-icons/react";
import {
  CLOUD_SIGN_INS,
  CLOUD_SIGN_IN_GAPS,
  type CloudSignInId,
  type CloudSignInSpec,
  type CloudSignInStatus,
} from "../../../shared/cloudSignIns";
import { SettingsTextField } from "./primitives";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ProviderLogo } from "../shared/ProviderLogos";
import { ipcErrorMessage } from "../../lib/format";
import { openExternalUrl } from "../../lib/openExternal";

/** A row's note is a sentence the person needs whole, not a one-line detail. */
const WRAP = { whiteSpace: "normal" } as const;

/** How often the card reads Claude's sign-in while it runs on the brain. */
const CLAUDE_POLL_MS = 1_500;

export type CloudSignIns = {
  status: CloudSignInStatus | null;
  error: string | null;
  reload: () => Promise<void>;
  setStatus: (status: CloudSignInStatus) => void;
};

/**
 * The one read of the account's cloud sign-ins on the provider page, shared by
 * every card that shows them. While Claude's sign-in runs (on this computer's
 * brain), it is read again every 1.5 s; otherwise only when a window changed it.
 */
export function useCloudSignIns(enabled: boolean): CloudSignIns {
  const bridge = window.ade.cloud;
  const [status, setStatus] = useState<CloudSignInStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled || !bridge?.cloudSignInStatus) return;
    try {
      const next = await bridge.cloudSignInStatus();
      if (next) setStatus(next);
      setError(null);
    } catch (loadError) {
      setError(ipcErrorMessage(loadError) || "Couldn't read your sign-ins for cloud machines.");
    }
  }, [bridge, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const off = bridge?.onCloudSignInChanged?.(() => { void reload(); });
    return () => off?.();
  }, [bridge, enabled, reload]);

  const claudeLive = status?.claude?.state === "running" || status?.claude?.state === "saving";
  useEffect(() => {
    if (!claudeLive) return;
    const timer = window.setInterval(() => { void reload(); }, CLAUDE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [claudeLive, reload]);

  return { status, error, reload, setStatus };
}

/**
 * Settings › Integrations › the provider: the provider sign-ins every new the provider
 * machine starts with. Claude signs in with Claude Code's own `setup-token`
 * (run by this computer's ADE background service); the others take the API
 * key their CLI reads. Kept in the account, so account-wide: no pin.
 */
export function CloudSignInsCard({ signIns }: { signIns: CloudSignIns }) {
  const bridge = window.ade.cloud;
  const { status, setStatus, reload } = signIns;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CloudSignInId | null>(null);
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState("");
  // Set by this window's Sign in, so only it opens the page: every window
  // reads the same sign-in, and a card shown again must not reopen it.
  const opensSignInPage = useRef(false);

  const claude = status?.claude ?? null;
  const claudeLive = claude?.state === "running" || claude?.state === "saving";
  const claudeUrl = claudeLive ? claude?.url ?? null : null;

  // A sign-in that ended, link or not, opens nothing more.
  useEffect(() => {
    if (!claudeLive) opensSignInPage.current = false;
  }, [claudeLive]);

  // Claude's sign-in page opens once, when Claude Code prints its link.
  useEffect(() => {
    if (claudeUrl && opensSignInPage.current) {
      opensSignInPage.current = false;
      openExternalUrl(claudeUrl);
    }
  }, [claudeUrl]);

  const run = async (action: () => Promise<CloudSignInStatus | null | undefined>) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setStatus(next);
      return true;
    } catch (actionError) {
      setError(ipcErrorMessage(actionError) || "That didn't work. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!bridge?.cloudSignInStatus) return null;
  const shownError = error ?? signIns.error;
  const savedById = new Map((status?.saved ?? []).map((entry) => [entry.id, entry.saved]));
  const savedCount = [...savedById.values()].filter(Boolean).length;

  const submitCode = () => void run(async () => {
    const next = await bridge.cloudSignInClaudeCode?.(code);
    setCode("");
    return next;
  });
  const startClaude = () => {
    opensSignInPage.current = true;
    void run(async () => await bridge.cloudSignInClaudeStart?.()).then((ok) => {
      if (!ok) opensSignInPage.current = false;
    });
  };
  const saveKey = (spec: CloudSignInSpec) => void run(async () => {
    const next = await bridge.cloudSignInSaveKey?.(spec.id, draft);
    setDraft("");
    setEditing(null);
    return next;
  });

  const claudeFlow = claudeLive ? (
    <div className="ade-ig-method-extra">
      {claude?.state === "saving" ? (
        <p className="ade-ig-note"><CircleNotch size={12} className="animate-spin" /> Saving to your ADE account…</p>
      ) : claude?.awaitingCode ? (
        <div className="ade-ig-form">
          <p className="ade-ig-note">Paste the code the browser shows.</p>
          <div className="ade-ig-form-row">
            <SettingsTextField
              value={code}
              onChange={setCode}
              placeholder="Code from the browser"
              ariaLabel="Code from the browser"
              mono
              onKeyDown={(event) => { if (event.key === "Enter" && code.trim()) submitCode(); }}
            />
            <button type="button" className="ade-modern-btn" data-tone="primary" disabled={busy || !code.trim()} onClick={submitCode}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <p className="ade-ig-note"><CircleNotch size={12} className="animate-spin" /> Finish signing in to Claude in your browser.</p>
      )}
      <div className="ade-ig-step-actions" style={{ marginTop: 0 }}>
        {claudeUrl ? (
          <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => openExternalUrl(claudeUrl)}>
            <ArrowSquareOut size={12} /> Open the sign-in page
          </button>
        ) : null}
        <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy || claude?.state === "saving"} onClick={() => void run(async () => await bridge.cloudSignInClaudeCancel?.())}>
          Cancel
        </button>
      </div>
    </div>
  ) : null;

  const keyForm = (spec: CloudSignInSpec) => {
    const keyUrl = spec.keyUrl;
    return (
      <div className="ade-ig-method-extra">
        <div className="ade-ig-form-row">
          <SettingsTextField
            type="password"
            value={draft}
            onChange={setDraft}
            placeholder={`Paste your ${spec.keyName}`}
            ariaLabel={spec.keyName}
            mono
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) saveKey(spec); }}
          />
          <button type="button" className="ade-modern-btn" data-tone="primary" disabled={busy || !draft.trim()} onClick={() => saveKey(spec)}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        {keyUrl ? (
          <div className="ade-ig-step-actions" style={{ marginTop: 0 }}>
            <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => openExternalUrl(keyUrl)}>
              <ArrowSquareOut size={12} /> Get a key
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <IntegrationCard
      anchor="cloud-sign-ins"
      icon={<Key size={15} weight="fill" />}
      title="Sign-ins for your cloud machines"
      badge={savedCount ? <span className="kit-tag" data-tone="ok">{savedCount} saved</span> : null}
      tone={claudeLive ? "focus" : undefined}
      hint="Add them once. Every new ADE Cloud machine then starts signed in, so a chat there works right away. Machines made before keep what they had."
    >
      <div className="ade-ig-rows" style={{ marginBottom: -18 }}>
        {CLOUD_SIGN_INS.map((spec) => {
          const saved = savedById.get(spec.id) === true;
          const isClaude = spec.method === "claude-token";
          const open = editing === spec.id;
          return (
            <div key={spec.id} className="ade-ig-method" data-active={saved ? "true" : undefined} data-cloud-sign-in={spec.id}>
              <span className="ade-ig-method-icon" aria-hidden><ProviderLogo family={spec.id} size={16} /></span>
              <span className="ade-ig-method-name">
                <b>{spec.label}</b>
                <small style={WRAP}>{saved ? (isClaude ? "Signed in" : `${spec.keyName} saved`) : spec.note}</small>
              </span>
              <span className="ade-ig-method-side">
                {saved && !(isClaude && claudeLive) ? (
                  <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void run(async () => await bridge.cloudSignInRemove?.(spec.id))}>
                    Remove
                  </button>
                ) : null}
                {isClaude ? (
                  claudeLive ? null : (
                    <button type="button" className="ade-modern-btn" data-size="sm" data-tone={saved ? undefined : "primary"} disabled={busy || !status} onClick={startClaude}>
                      {saved ? "Sign in again" : "Sign in"}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="ade-modern-btn"
                    data-size="sm"
                    disabled={busy || !status}
                    onClick={() => { setDraft(""); setEditing(open ? null : spec.id); }}
                  >
                    {open ? "Cancel" : saved ? "Replace" : "Add key"}
                  </button>
                )}
                {saved ? <CheckCircle size={14} weight="fill" aria-label="Saved" /> : null}
              </span>
              {isClaude ? claudeFlow : null}
              {!isClaude && open ? keyForm(spec) : null}
            </div>
          );
        })}
        {CLOUD_SIGN_IN_GAPS.map((gap) => (
          <div key={gap.label} className="ade-ig-method" data-cloud-sign-in-gap={gap.label}>
            <span className="ade-ig-method-icon" aria-hidden><ProviderLogo family={gap.provider} size={16} /></span>
            <span className="ade-ig-method-name">
              <b>{gap.label}</b>
              <small style={WRAP}>{gap.reason}</small>
            </span>
            <span className="ade-ig-method-side"><span className="kit-tag">No key</span></span>
          </div>
        ))}
      </div>
      {claude?.state === "failed" && claude.message ? (
        <Banner layout="inline" model={{ id: "cloud-claude-failed", tone: "error", title: "Claude sign-in didn't finish", detail: claude.message }} />
      ) : null}
      {status?.unknown ? (
        <Banner layout="inline" model={{ id: "cloud-sign-ins-unknown", tone: "warning", title: "Couldn't read your ADE account", detail: "ADE can't tell which sign-ins are saved. Check again in a moment.", actions: [{ label: "Check again", onClick: () => { void reload(); } }] }} />
      ) : null}
      {shownError ? (
        <Banner
          layout="inline"
          model={{
            id: "cloud-sign-ins-error",
            tone: "error",
            title: "Sign-ins for cloud machines",
            detail: shownError,
            // A failed read (no project open yet, the brain restarting) can be read again.
            actions: [{ label: "Check again", onClick: () => { setError(null); void reload(); } }],
          }}
        />
      ) : null}
    </IntegrationCard>
  );
}
