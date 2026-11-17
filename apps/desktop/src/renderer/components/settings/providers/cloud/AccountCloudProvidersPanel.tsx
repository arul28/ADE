import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudAccountSignIn, CloudAccountSignIns, CloudCatalogProvider } from "../../../../../shared/accountCloudLaunches";
import { useCloudModelCatalog } from "../../../../state/cloudModelCatalog";
import { openExternalUrl } from "../../../../lib/openExternal";
import { extractError } from "../../../../lib/format";
import { Banner } from "../../../ui/notice";
import { confirmDialog } from "../../../ui/dialog";

/**
 * Settings › Providers in ADE Web for a person with no computer of their own:
 * what each provider needs on ADE Cloud, from the account server
 * (`GET /cloud/models`, `GET /cloud/sign-ins`). API keys save to the account
 * vault (`PUT /cloud/sign-ins/:id`) and every later cloud computer reads them.
 * A provider that signs in on the computer does that at the first chat (the
 * setup card); one that signs in only in ADE desktop says so.
 */
export function AccountCloudProvidersPanel() {
  const { catalog, error: catalogError, loading, retry } = useCloudModelCatalog(true);
  const [signIns, setSignIns] = useState<CloudAccountSignIns | null>(null);
  const [signInsError, setSignInsError] = useState<string | null>(null);
  const reload = useCallback(() => {
    const api = window.ade?.cloudLaunches;
    if (!api) return;
    setSignInsError(null);
    void api.signIns().then(setSignIns, (error: unknown) => setSignInsError(extractError(error)));
  }, []);
  useEffect(() => reload(), [reload]);
  // Rows save at the same time; each answer is the whole list, so an older answer never replaces a newer one.
  const changeSeq = useRef(0);
  const appliedSeq = useRef(0);
  const beginChange = useCallback(() => {
    const seq = ++changeSeq.current;
    return (next: CloudAccountSignIns) => {
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      setSignIns(next);
    };
  }, []);

  const signInFor = (provider: string): CloudAccountSignIn | null =>
    signIns?.signIns.find((entry) => entry.providers.includes(provider)) ?? null;

  return (
    <div className="flex w-full max-w-[720px] flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold">Providers on ADE Cloud</h2>
        <p className="m-0 text-[12px]" style={{ color: "var(--kit-text-2)" }}>
          What each coding agent needs before it runs a chat on ADE Cloud. Keys save to your account, so every cloud computer can use them.
        </p>
      </div>
      {catalogError ? (
        <Banner
          layout="inline"
          model={{
            id: "account-cloud-providers-models",
            tone: "error",
            title: "Couldn't load the providers",
            actions: [{ label: "Try again", onClick: retry }],
            report: { surface: "settings_providers_account_cloud", code: "cloud_models_unavailable", technicalDetail: catalogError },
          }}
        />
      ) : null}
      {signInsError ? (
        <Banner
          layout="inline"
          model={{
            id: "account-cloud-providers-sign-ins",
            tone: "error",
            title: "Couldn't read your saved keys",
            actions: [{ label: "Try again", onClick: reload }],
            report: { surface: "settings_providers_account_cloud", code: "cloud_sign_ins_unavailable", technicalDetail: signInsError },
          }}
        />
      ) : null}
      {!catalog && loading ? <p className="m-0 text-[12px]" style={{ color: "var(--kit-text-3)" }}>Loading…</p> : null}
      {catalog ? (
        <section className="kit-card w-full" aria-label="Providers">
          <div className="kit-card-body flex flex-col" style={{ paddingTop: 4 }}>
            {catalog.providers.map((provider) => (
              <ProviderRow
                key={provider.provider}
                provider={provider}
                signIn={signInFor(provider.provider)}
                vaultUnknown={signIns?.unknown === true}
                beginChange={beginChange}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** The tag and the line under a provider, for how it signs in on ADE Cloud. */
function signInRowCopy(
  kind: CloudCatalogProvider["remoteSignIn"],
  facts: { saved: boolean; vaultUnknown: boolean; keyName: string | null },
): { status: string; line: string } {
  switch (kind) {
    case "desktop":
      return { status: "Sign in from ADE desktop", line: "This provider signs in only in ADE desktop. Sign in there, and cloud chats can use it." };
    case "api_key":
      return {
        status: facts.saved ? "Key saved" : facts.vaultUnknown ? "Couldn't check" : "Needs a key",
        line: `${facts.keyName ?? "An API key"}, saved to your account.`,
      };
    case "url_paste":
      return {
        status: facts.saved ? "Pass saved" : "Signs in at your first chat",
        line: "The cloud computer opens a sign-in page. Paste the code it shows, and ADE keeps the pass for later computers.",
      };
    default:
      return { status: "Signs in at your first chat", line: "The cloud computer shows a code. Enter it on the provider's page." };
  }
}

function ProviderRow({
  provider,
  signIn,
  vaultUnknown,
  beginChange,
}: {
  provider: CloudCatalogProvider;
  signIn: CloudAccountSignIn | null;
  vaultUnknown: boolean;
  /** Starts a change; the answer it returns applies the list the server sent back. */
  beginChange: () => (next: CloudAccountSignIns) => void;
}) {
  const kind = provider.remoteSignIn;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = signIn?.saved === true;

  const { status, line } = signInRowCopy(kind, { saved, vaultUnknown, keyName: signIn?.keyName ?? null });

  const save = () => {
    const api = window.ade?.cloudLaunches;
    if (!api || !signIn || busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    const apply = beginChange();
    void api.saveSignIn(signIn.id, value.trim()).then(
      (next) => {
        apply(next);
        setValue("");
        setEditing(false);
      },
      (failure: unknown) => setError(extractError(failure)),
    ).finally(() => setBusy(false));
  };
  const remove = async () => {
    const api = window.ade?.cloudLaunches;
    if (!api || !signIn) return;
    const ok = await confirmDialog({
      title: `Remove your ${provider.label} key?`,
      message: "ADE Cloud chats can't use this provider until you add a key again.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const apply = beginChange();
    try {
      apply(await api.removeSignIn(signIn.id));
    } catch (failure) {
      setError(extractError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 py-2" style={{ borderBottom: "1px solid var(--kit-line, color-mix(in srgb, var(--color-fg) 6%, transparent))" }}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{provider.label}</span>
        <span className="kit-tag shrink-0" data-tone={kind === "api_key" && saved ? "ok" : undefined}>{status}</span>
        {kind === "api_key" && signIn ? (
          saved ? (
            <>
              <button type="button" className="kit-btn" data-size="sm" disabled={busy} onClick={() => setEditing(true)}>Replace</button>
              <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" data-tone="crit" disabled={busy} onClick={() => void remove()}>Remove</button>
            </>
          ) : (
            <button type="button" className="kit-btn" data-size="sm" disabled={busy} onClick={() => setEditing(true)}>Add key</button>
          )
        ) : null}
      </div>
      <span className="text-[11.5px]" style={{ color: "var(--kit-text-3)" }}>{line}</span>
      {editing && signIn ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="kit-input"
            data-size="sm"
            type="password"
            autoFocus
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            style={{ flex: "1 1 220px" }}
            placeholder={signIn.keyName}
            aria-label={`${signIn.keyName} for ${provider.label}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={busy || !value.trim()} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          {signIn.keyUrl ? (
            <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => openExternalUrl(signIn.keyUrl)}>
              Get a key
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <Banner
          layout="inline"
          model={{
            id: `account-cloud-provider-${provider.provider}`,
            tone: "error",
            title: `Couldn't save the key for ${provider.label}`,
            detail: error,
            report: { surface: "settings_providers_account_cloud", code: "cloud_sign_in_write_failed", technicalDetail: error },
          }}
        />
      ) : null}
    </div>
  );
}
