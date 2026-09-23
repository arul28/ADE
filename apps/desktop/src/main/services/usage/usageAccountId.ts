/**
 * The one rule for a usage account id, shared by the quota poller
 * (`UsageAccount.id`, `UsageWindow.accountId`) and the per-turn ledger
 * (`accountKey`), so the router's join between a turn and a quota window can
 * never drift:
 *
 * - `<provider>:<instanceId>` for the providers that hold several logins,
 * - else `<provider>:<email>` (lower-cased),
 * - else `<provider>:local`, the one account a machine with no identity has.
 */
export function usageAccountId(args: {
  provider: string;
  instanceId?: string | null;
  email?: string | null;
}): string {
  const instanceId = args.instanceId?.trim();
  if (instanceId) return `${args.provider}:${instanceId}`;
  const email = args.email?.trim();
  return email ? `${args.provider}:${email.toLowerCase()}` : localUsageAccountId(args.provider);
}

/** The account id of a provider's unnamed login: `<provider>:local`. */
export function localUsageAccountId(provider: string): string {
  return `${provider}:local`;
}
