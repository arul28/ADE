import { providerAccountName, type ProviderInstance } from "../../../../shared/types/providerInstances";

export type ImportAccountPickerProps = {
  /** Every account this machine has for the session's provider. */
  accounts: ProviderInstance[];
  /** The chosen account id; null keeps the account that owns the transcript. */
  value: string | null;
  /** The account whose config home holds the transcript, when the host named it. */
  sessionAccountId: string | null;
  disabled: boolean;
  onChange: (accountId: string | null) => void;
};

function accountLabel(instance: ProviderInstance): string {
  const name = instance.label?.trim() || providerAccountName(instance);
  return instance.isDefault ? `${name} (default)` : name;
}

/**
 * Which signed-in account the imported session runs on.
 *
 * The session's transcript lives in one account's config home, and a CLI only
 * finds a session id inside the home it runs with. ADE copies the transcript
 * into the chosen account's home when they differ, so this is a "run it on this
 * account" choice, not a re-import. "Session's account" is always first: a home
 * whose account was removed from the registry still holds a resumable session.
 */
export function ImportAccountPicker({
  accounts,
  value,
  sessionAccountId,
  disabled,
  onChange,
}: ImportAccountPickerProps) {
  const selected = value ?? "";
  return (
    <select
      data-testid="import-account"
      aria-label="Account to run this session on"
      title="The account this import runs on. Picking another account copies the session into that account's folder first."
      disabled={disabled}
      value={selected}
      onChange={(event) => onChange(event.target.value || null)}
      className="import-account-select"
    >
      <option value="">Session's account</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.id === sessionAccountId
            ? `${accountLabel(account)} — this session`
            : accountLabel(account)}
        </option>
      ))}
    </select>
  );
}
