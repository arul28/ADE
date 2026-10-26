import { useState, type FormEvent } from "react";

import type { AdeChatClient, ProviderId } from "../sdkTypes";

export type ApiKeyFormProps = {
  provider: ProviderId;
  client?: AdeChatClient;
  onSubmit?: (input: { provider: ProviderId; key: string; label?: string }) => unknown | Promise<unknown>;
  className?: string;
};

/** The form accepts a new key and never receives or renders a stored key. */
export function ApiKeyForm({ provider, client, onSubmit, className }: ApiKeyFormProps) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = onSubmit ?? client?.credentials?.add?.bind(client.credentials);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!save || !key || busy) return;
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      await save({ provider, key, ...(label.trim() ? { label: label.trim() } : {}) });
      setKey("");
      setSaved(true);
    } catch {
      // Do not show service errors here: a service may echo the submitted key.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (!save) return null;

  return (
    <form className={["adechat-api-key-form", className].filter(Boolean).join(" ")} onSubmit={(event) => void submit(event)}>
      <label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} autoComplete="off" disabled={busy} /></label>
      <label>API key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="new-password" spellCheck={false} disabled={busy} /></label>
      <button type="submit" className="adechat-button" data-variant="primary" disabled={busy || !key}>{busy ? "Saving…" : "Save API key"}</button>
      {saved ? <span className="adechat-sign-in-state" role="status">API key saved.</span> : null}
      {failed ? <span className="adechat-account-error" role="alert">Could not save this API key.</span> : null}
    </form>
  );
}
