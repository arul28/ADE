import { usageAccountId } from "../../../shared/usageAccountId";

export { localUsageAccountId, usageAccountId } from "../../../shared/usageAccountId";

/**
 * The account id for one provider instance: the snapshot's own id when the
 * account is present, else the `<provider>:<instanceId>` rule. One helper so
 * the picker and the balance service cannot join a window to the wrong login.
 */
export function usageAccountIdForInstance(args: {
  provider: string;
  instanceId: string;
  accounts?: readonly { id: string; provider: string; instanceId?: string | null }[];
}): string {
  const account = args.accounts?.find(
    (candidate) => candidate.provider === args.provider && candidate.instanceId === args.instanceId,
  );
  return account?.id ?? usageAccountId({ provider: args.provider, instanceId: args.instanceId });
}
