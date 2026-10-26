import { useState } from "react";
import { requireAccepted } from "../actionResult";

import type { AccountInfo, AdeThread } from "../sdkTypes";

export type AccountSwitcherProps = {
  accounts: readonly AccountInfo[];
  currentAccountId?: string | null;
  thread?: Pick<AdeThread, "switchAccount"> | null;
  onSwitch?: (instanceId: string) => void | Promise<void>;
  className?: string;
};

export function AccountSwitcher({ accounts, currentAccountId, thread, onSwitch, className }: AccountSwitcherProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchTo = onSwitch ?? (thread?.switchAccount ? (id: string) => requireAccepted(thread.switchAccount!(id)) : undefined);
  if (!switchTo) return null;
  const choices = accounts.filter((account) => account.signedIn);
  if (choices.length < 2) return null;

  return (
    <label className={["adechat-account-switcher", className].filter(Boolean).join(" ")}>
      <span>Account</span>
      <select
        value={currentAccountId ?? ""}
        disabled={busy}
        onChange={(event) => {
          const id = event.target.value;
          if (!id || id === currentAccountId) return;
          setBusy(true);
          setError(null);
          void Promise.resolve(switchTo(id)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
        }}
      >
        <option value="" disabled>Select an account</option>
        {choices.map((account) => <option key={account.id} value={account.id}>{account.label || account.provider}</option>)}
      </select>
      {error ? <span className="adechat-account-error" role="alert">Could not switch account: {error}</span> : null}
    </label>
  );
}
