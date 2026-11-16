import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretUpDown, Check } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { getModelById, resolveChatProviderForDescriptor } from "../../../shared/modelRegistry";
import {
  isProviderInstanceProvider,
  providerAccountName,
  type ProviderInstance,
  type ProviderInstanceProvider,
} from "../../../shared/types/providerInstances";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../ui/paneMenuTokens";

/** The multi-account provider a model runs on, or null when it has one login per machine. */
export function ctoAccountProviderFor(modelId: string | null | undefined): ProviderInstanceProvider | null {
  const descriptor = modelId ? getModelById(modelId) : undefined;
  if (!descriptor) return null;
  const provider = resolveChatProviderForDescriptor(descriptor).provider;
  return isProviderInstanceProvider(provider) ? provider : null;
}

/**
 * The signed-in accounts of `provider` on the CTO's machine, or null while
 * unread. Read through the CTO's pin: accounts are per machine.
 */
export function useCtoAccounts(
  provider: ProviderInstanceProvider | null,
  pin: OpenProjectBinding | null | undefined,
): ProviderInstance[] | null {
  const [accounts, setAccounts] = useState<ProviderInstance[] | null>(null);
  const pinKey = pin?.key ?? null;
  useEffect(() => {
    if (!provider || !window.ade?.providerInstances?.list) {
      setAccounts(null);
      return;
    }
    let cancelled = false;
    void window.ade.providerInstances.list({ provider }, pin ?? null).then(
      (rows) => {
        if (!cancelled) setAccounts(rows.filter((row) => row.provider === provider && row.signedIn && !row.sameLoginAs));
      },
      () => {
        if (!cancelled) setAccounts(null);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the pin's key, not its object
  }, [provider, pinKey]);
  return accounts;
}

/**
 * Which signed-in account runs a CTO model. Renders nothing unless the model's
 * provider has two or more accounts on the CTO's machine. `value` null is the
 * provider's default account.
 */
export function CtoAccountPicker({
  modelId,
  value,
  pin,
  disabled,
  onChange,
}: {
  modelId: string | null | undefined;
  value: string | null | undefined;
  pin: OpenProjectBinding | null | undefined;
  disabled?: boolean;
  onChange: (instanceId: string | null) => void;
}) {
  const provider = ctoAccountProviderFor(modelId);
  const accounts = useCtoAccounts(provider, pin);
  if (!provider || !accounts || accounts.length < 2) return null;
  const fallback = accounts.find((account) => account.isDefault) ?? accounts[0]!;
  const selected = (value ? accounts.find((account) => account.id === value) : null) ?? fallback;
  const nameOf = (account: ProviderInstance) => providerAccountName(account);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          className="kit-btn inline-flex max-w-[220px] items-center gap-1.5"
          data-size="xs"
          aria-label={`Account: ${nameOf(selected)}`}
          title={nameOf(selected)}
        >
          {selected.accentColor ? (
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: selected.accentColor }} aria-hidden />
          ) : null}
          <span className="truncate">{nameOf(selected)}</span>
          <CaretUpDown size={11} className="shrink-0 opacity-60" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
          {accounts.map((account) => (
            <DropdownMenu.Item
              key={account.id}
              className={MENU_ITEM_CLASS}
              onSelect={() => onChange(account.isDefault ? null : account.id)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {account.accentColor ? (
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: account.accentColor }} aria-hidden />
                ) : null}
                <span className="truncate">{nameOf(account)}</span>
              </span>
              {account.id === selected.id ? <Check size={12} aria-hidden /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
