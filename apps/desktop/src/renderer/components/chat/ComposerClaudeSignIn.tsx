/**
 * "Login to Claude" from a composer's model picker, run on the composer's
 * machine with Settings' own flow: the default account's guided sign-in sheet,
 * or, on a host without an account bridge, a login terminal on that machine.
 *
 * The picker greys Claude out from the composer machine's auth status, so the
 * sign-in has to land on that same machine; opening a terminal on the tab's
 * machine signed in a computer that was usually already signed in.
 */
import React, { useEffect, useMemo, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import { captureError } from "../../../shared/sentry/capture";
import { CLAUDE_AUTH_LOGIN_COMMAND } from "../../lib/claudeAuthPrompt";
import { SettingsMachineScopeProvider, settingsMachineScope } from "../settings/SettingsMachineScope";
import { AddProviderAccountSheet } from "../settings/providers/accounts/AddProviderAccountSheet";
import { pinnedProviderInstances } from "../settings/providers/accounts/useProviderInstances";
import { ProviderSignInModal } from "../settings/providers/ProviderSignInModal";

export type ComposerClaudeSignInTarget = {
  /** Distinguishes one click from the next, so a retry starts over. */
  openId: number;
  /** The machine to sign in on. Null is the tab's own machine, when that is This computer. */
  pin: OpenProjectBinding | null;
  machineId: string;
  isThisMachine: boolean;
  machineName: string;
};

const CLAUDE_LABEL = "Claude Code";

function ClaudeSignInOnMachine({
  pin,
  onClose,
}: {
  pin: OpenProjectBinding | null;
  onClose: (changed: boolean) => void;
}) {
  // undefined while the account list is read; null when there is no default
  // account or no bridge to read it with.
  const [instance, setInstance] = useState<ProviderInstance | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setInstance(undefined);
    const api = pinnedProviderInstances(pin);
    if (!api) {
      setInstance(null);
      return;
    }
    api.list({ provider: "claude" })
      .then((list) => {
        if (alive) setInstance(list.find((entry) => entry.isDefault) ?? null);
      })
      .catch((error) => {
        // The login terminal below still signs that machine in.
        captureError(error, { fingerprint: ["composer-claude-sign-in", "account-list"] });
        if (alive) setInstance(null);
      });
    return () => {
      alive = false;
    };
    // Keyed on the machine, not the pin object: a rebuilt pin with the same
    // key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.key]);

  if (instance === undefined) return null;
  if (instance) {
    return (
      <AddProviderAccountSheet
        provider="claude"
        providerLabel={CLAUDE_LABEL}
        existingInstance={instance}
        onClose={onClose}
      />
    );
  }
  return (
    <ProviderSignInModal
      providerId="claude"
      providerLabel={CLAUDE_LABEL}
      command={CLAUDE_AUTH_LOGIN_COMMAND}
      runtimePin={pin}
      onClose={() => onClose(true)}
      checkSignedIn={async () => {
        const status = await window.ade?.ai?.getStatus?.({ force: true }, pin);
        return status?.providerConnections?.claude?.authAvailable === true;
      }}
    />
  );
}

export function ComposerClaudeSignIn({
  target,
  onClose,
}: {
  target: ComposerClaudeSignInTarget;
  onClose: (changed: boolean) => void;
}) {
  const { pin, machineId, isThisMachine, machineName } = target;
  const scope = useMemo(() => settingsMachineScope({
    machineId,
    machineName,
    target: pin ? { kind: "pinned", binding: pin } : { kind: "this" },
    isThisMachine,
    isActiveBinding: !pin,
    online: true,
  }), [isThisMachine, machineId, machineName, pin]);
  return (
    <SettingsMachineScopeProvider scope={scope}>
      <ClaudeSignInOnMachine pin={pin} onClose={onClose} />
    </SettingsMachineScopeProvider>
  );
}
