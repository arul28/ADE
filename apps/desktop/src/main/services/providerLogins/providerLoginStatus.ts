/**
 * The sync's status (`provider_logins.status`): this computer's capture,
 * the account's sign-ins, each provider's state here, and on a cloud
 * computer what apply wrote. Reads only memory, the vault cache and the
 * marks file. Never a token, a key, a file's content or a hash.
 */

import {
  isProviderLoginProvider,
  type ProviderLoginApplied,
  type ProviderLoginLocalState,
  type ProviderLoginProvider,
  type ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { PROVIDER_LOGIN_CARRY } from "./providerLoginCarry";
import { readProviderLoginStatusParts } from "./providerLoginHooks";
import { originId } from "./providerLoginPayload";
import { APPLY_MESSAGES, LOCAL_MESSAGES, LOCAL_STATE_RANK, OFF_MESSAGES, type SyncShared } from "./providerLoginSyncShared";

export function createStatus(s: SyncShared) {
  const { deps, ctx, localStates, applyStates, ownerOff, jobs } = s;
  const { cloudSetting, captureOffReason, loadState, signInsFromVault } = s;

  async function status(provider?: ProviderLoginProvider | null): Promise<ProviderLoginStatus> {
    const off = await captureOffReason();
    const vault = deps.staticOff ? null : deps.vault();
    const machine = deps.staticOff ? null : deps.machine();
    const setting = cloudSetting();
    const origin12 = machine ? originId(machine.machineKey) : null;
    const signIns = signInsFromVault(deps.accountUserId() ? vault : null, origin12, setting, machine?.deviceId ?? null)
      .filter((signIn) => !provider || signIn.provider === provider);
    const accountUserId = deps.staticOff ? null : deps.accountUserId();
    const writtenBack = accountUserId ? loadState(accountUserId).writtenBack ?? {} : {};
    const ghCli = !provider || provider === "copilot" ? await jobs.ghCliStatus(off) : null;
    const providers = PROVIDER_LOGIN_CARRY
      .filter((row) => !provider || row.provider === provider)
      .map((row) => {
        const slots = [...(localStates.get(row.provider)?.values() ?? [])];
        let best = slots.sort((left, right) => LOCAL_STATE_RANK.indexOf(left.state) - LOCAL_STATE_RANK.indexOf(right.state))[0]
          ?? { state: "not_checked" as ProviderLoginLocalState, key: null };
        if (off || row.carry !== "carried") best = { state: "not_checked", key: null };
        if ((best.state === "not_signed_in" || best.state === "not_checked") && row.carry !== "never" && row.osStore?.(ctx)) {
          best = { state: "os_store", key: null };
        }
        let message = row.carry === "carried" && best.state !== "not_checked" ? LOCAL_MESSAGES[best.state] : row.message;
        const back = best.state === "written_back" && best.key ? writtenBack[best.key] ?? null : null;
        if (back) message = `Renewed by ${back.renewedBy}. ADE wrote the newer copy into the login file here.`;
        const keychain = jobs.keychainStatus(row.provider, off, vault);
        if (keychain?.key && !off) {
          best = { state: "captured", key: keychain.key };
          message = keychain.part.message;
        }
        if (row.provider === "copilot" && ghCli) message = jobs.ghCliMessage(ghCli, off, message);
        return {
          provider: row.provider,
          carry: row.carry,
          message,
          local: {
            state: best.state,
            key: best.key,
            ...(back ? { writtenBack: { at: new Date(back.at).toISOString(), renewedBy: back.renewedBy } } : {}),
          },
          ...(keychain ? { keychain: keychain.part } : {}),
          ...(row.provider === "copilot" && ghCli ? { ghCli } : {}),
        };
      });
    return {
      thisComputer: {
        capture: off ? "off" : "on",
        reason: off,
        message: off ? OFF_MESSAGES[off] : null,
        label: machine?.label ?? null,
        cloudComputer: deps.cloudComputer,
        lastPassAt: s.lastPassAt ? new Date(s.lastPassAt).toISOString() : null,
      },
      cloud: { enabled: setting.enabled, inUse: { ...setting.inUse }, claude: { smartBalance: setting.smartBalance } },
      signIns,
      providers,
      applied: deps.cloudComputer && !deps.staticOff ? appliedStatus(provider ?? null) : null,
      // Fields other packages add (P6: `claudePasses`), never the sync's own.
      ...(deps.staticOff ? {} : await readProviderLoginStatusParts(provider ?? null)),
    };
  }

  function appliedStatus(provider: ProviderLoginProvider | null): ProviderLoginApplied[] {
    const entries = s.appliedCache?.applied ?? {};
    const places = [...new Set([...applyStates.keys(), ...Object.keys(entries)])].sort();
    return places
      .map((place): ProviderLoginApplied => {
        const placeProvider = place.startsWith("pi:") ? "pi" : place;
        const entry = entries[place] ?? null;
        const local = applyStates.get(place) ?? { state: entry ? "applied" as const : "none" as const, key: entry?.source ?? null };
        return {
          place,
          provider: isProviderLoginProvider(placeProvider) ? placeProvider : null,
          state: local.state,
          key: local.key,
          accessOnly: entry?.accessOnly ?? false,
          renewalSafe: entry?.renewalSafe ?? true,
          appliedAt: entry ? new Date(entry.appliedAt).toISOString() : null,
          message: APPLY_MESSAGES[local.state],
          ownerOff: ownerOff.has(place) ? { ownerLabel: ownerOff.get(place)!.ownerLabel, at: new Date(ownerOff.get(place)!.at).toISOString() } : null,
        };
      })
      .filter((entry) => !provider || entry.provider === provider);
  }

  return { status };
}
