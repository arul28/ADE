import { useEffect, useRef, useState, type FormEvent } from "react";

import type { AccountInfo, SignInHandle, SignInUpdate } from "../sdkTypes";

export type SignInCardProps = {
  handle?: SignInHandle | null;
  onStart?: () => SignInHandle | Promise<SignInHandle>;
  onComplete?: (account: AccountInfo) => void;
  className?: string;
};

export function SignInCard({ handle: providedHandle, onStart, onComplete, className }: SignInCardProps) {
  const [handle, setHandle] = useState<SignInHandle | null>(providedHandle ?? null);
  const [update, setUpdate] = useState<SignInUpdate>({ state: "running" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => setHandle(providedHandle ?? null), [providedHandle]);

  useEffect(() => {
    if (!handle) return;
    let active = true;
    const stop = handle.on("update", (next) => {
      if (active) setUpdate(next);
    });
    void handle.done.then((account) => {
      if (!active) return;
      setUpdate((current) => ({ ...current, state: "succeeded" }));
      onCompleteRef.current?.(account);
    }).catch((cause: unknown) => {
      if (active) {
        setUpdate((current) => ({ ...current, state: "failed" }));
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [handle]);

  const start = async () => {
    if (!onStart || busy) return;
    setBusy(true);
    setError(null);
    try {
      setHandle(await onStart());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!handle || !code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await handle.submitCode(code);
      setCode("");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!handle || busy) return;
    setBusy(true);
    setError(null);
    try {
      await handle.cancel();
      setUpdate((current) => ({ ...current, state: "cancelled" }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={["adechat-sign-in", className].filter(Boolean).join(" ")} aria-label="Sign in">
      {update.url ? <a href={update.url} target="_blank" rel="noreferrer noopener">Continue sign-in</a> : null}
      {update.deviceCode ? <p className="adechat-sign-in-code">Device code: <code>{update.deviceCode}</code></p> : null}
      {update.message ? <p className="adechat-account-state">{update.message}</p> : null}
      {update.state === "verifying" ? <p className="adechat-sign-in-state" role="status">Checking the sign-in…</p> : null}
      {update.state === "succeeded" ? <p className="adechat-sign-in-state" role="status">Signed in.</p> : null}
      {update.state === "expired" ? <p className="adechat-account-error" role="alert">This sign-in expired. Start it again.</p> : null}
      {update.state === "cancelled" ? <p className="adechat-sign-in-state" role="status">Sign-in cancelled.</p> : null}
      {update.state === "failed" && !error ? <p className="adechat-account-error" role="alert">Sign-in could not continue.</p> : null}
      {update.awaitingCode && handle ? (
        <form className="adechat-sign-in-code-form" onSubmit={(event) => void submit(event)}>
          <label>Paste the code from the sign-in page<input autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} disabled={busy} /></label>
          <button type="submit" className="adechat-button" data-variant="primary" disabled={busy || !code.trim()}>Submit code</button>
        </form>
      ) : null}
      {handle && !["succeeded", "failed", "cancelled", "expired"].includes(update.state) ? (
        <button type="button" className="adechat-button" onClick={() => void cancel()} disabled={busy}>Cancel sign-in</button>
      ) : null}
      {!handle && onStart ? <button type="button" className="adechat-button" onClick={() => void start()} disabled={busy}>{busy ? "Starting…" : "Start sign-in"}</button> : null}
      {error ? <p className="adechat-account-error" role="alert">Sign-in could not continue: {error}</p> : null}
    </section>
  );
}
