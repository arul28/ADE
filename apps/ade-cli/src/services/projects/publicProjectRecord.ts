/**
 * A registry record as it may leave this machine. The account project link
 * goes only to the account it was made for, and the account id itself never
 * leaves this machine. `accountUserId` is the signed-in account's id, or a
 * reader that is called only for a linked record (so a list of unlinked
 * records never reads the account).
 */
export function publicProjectRecord<T extends { accountProjectId?: string; accountProjectUserId?: string }>(
  record: T,
  accountUserId: string | null | (() => string | null),
): Omit<T, "accountProjectId" | "accountProjectUserId"> & { accountProjectId?: string } {
  const { accountProjectUserId, accountProjectId, ...rest } = record;
  if (!accountProjectId) return rest;
  const signedIn = typeof accountUserId === "function" ? accountUserId() : accountUserId;
  return signedIn && accountProjectUserId === signedIn ? { ...rest, accountProjectId } : rest;
}

/**
 * The account fields a phone's project catalog and roster carry for a record:
 * the account project id (by the `publicProjectRecord` rule) and the GitHub
 * repository id. Each is left out when unknown, so an old phone sees the
 * same shape as before.
 */
export function publicAccountProjectFields(
  record: { accountProjectId?: string; accountProjectUserId?: string; githubRepoId?: number },
  accountUserId: string | null | (() => string | null),
): { accountProjectId?: string; githubRepoId?: number } {
  const linked = publicProjectRecord(
    { accountProjectId: record.accountProjectId, accountProjectUserId: record.accountProjectUserId },
    accountUserId,
  );
  return {
    ...(linked.accountProjectId ? { accountProjectId: linked.accountProjectId } : {}),
    ...(record.githubRepoId ? { githubRepoId: record.githubRepoId } : {}),
  };
}
