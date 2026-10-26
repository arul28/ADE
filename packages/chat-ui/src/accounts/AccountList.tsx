import { useCallback, useEffect, useState } from "react";

import type { AccountInfo, AdeChatClient } from "../sdkTypes";
import { UsageMeter } from "./UsageMeter";

export type AccountListProps = {
  client?: AdeChatClient;
  accounts?: readonly AccountInfo[];
  onSelect?: (account: AccountInfo) => void | Promise<void>;
  className?: string;
};

export function AccountList({ client, accounts: supplied, onSelect, className }: AccountListProps) {
  const [accounts, setAccounts] = useState<readonly AccountInfo[]>(supplied ?? []);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(supplied !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = client?.accounts;

  const refresh = useCallback(async () => {
    if (supplied !== undefined) {
      setAccounts(supplied);
      setLoaded(true);
      return;
    }
    if (!api?.list) return;
    setLoading(true);
    try {
      setAccounts(await api.list());
      setLoaded(true);
      setError(null);
    } catch (cause: unknown) {
      setLoaded(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api, supplied]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (action: () => unknown) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (supplied === undefined && !api?.list) {
    return <p className={joinClass("adechat-account-state", className)}>Account management is unavailable in this client.</p>;
  }

  return (
    <section className={joinClass("adechat-account-list", className)} aria-label="Provider accounts">
      {loading && !loaded ? <p className="adechat-account-state">Loading accounts…</p> : null}
      {error ? (
        <div className="adechat-account-error" role="alert">
          <span>Couldn’t load accounts: {error}</span>
          <button type="button" className="adechat-button" disabled={loading} onClick={() => void refresh()}>Retry</button>
        </div>
      ) : null}
      {loaded && accounts.length === 0 ? <p className="adechat-account-state">No accounts are available.</p> : null}
      {loaded ? accounts.map((account) => (
        <article className="adechat-account" key={account.id}>
          <div className="adechat-account-summary">
            <strong>{account.label || account.provider}</strong>
            <span>{[account.email, account.plan, account.signedIn ? "Signed in" : "Signed out", account.isDefault ? "Default" : null].filter(Boolean).join(" · ")}</span>
          </div>
          {account.usage ? <UsageMeter usage={account.usage} label={`${account.label} usage`} /> : null}
          {onSelect ? <button className="adechat-button" type="button" disabled={busy} onClick={() => void run(() => onSelect(account))}>Select</button> : null}
          {api?.setDefault && !account.isDefault ? <button className="adechat-button" type="button" disabled={busy} onClick={() => void run(() => api.setDefault!(account.id))}>Make default</button> : null}
          {api?.signOut && account.signedIn ? <button className="adechat-button" type="button" disabled={busy} onClick={() => void run(() => api.signOut!(account.id))}>Sign out</button> : null}
          {api?.remove ? <button className="adechat-button" type="button" data-variant="danger" disabled={busy} onClick={() => void run(() => api.remove!(account.id))}>Remove</button> : null}
        </article>
      )) : null}
    </section>
  );
}

function joinClass(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}
