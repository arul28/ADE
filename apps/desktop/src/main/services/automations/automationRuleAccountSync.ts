import type {
  AutomationRule,
  AutomationRuleHome,
  AutomationRuleLocalReason,
  AutomationTrigger,
  ConfigAutomationRule,
} from "../../../shared/types";
import { ADE_CLOUD_HOME_DEVICE_ID, ADE_CLOUD_HOME_NAME, AUTOMATION_HOME_HANDOVER_MS, isAdeCloudHome } from "../../../shared/automationHome";
import { automationCloudHomeProblem, localTimeZone } from "../../../shared/automationCloud";
import type { Logger } from "../logging/logger";
import {
  automationRuleAccountKey,
  fitsInAccount,
  isChatScopedAutomationRule,
  stableJson,
  type AutomationRuleAccountStore,
} from "./automationRuleAccountStore";

/**
 * How rules that follow the account meet `.ade/local.yaml`.
 *
 * `projectConfigService` owns the config file and validation; this module owns
 * the rules' account side: which rules are read from where, which computer
 * runs each, how a save, a delete or a move reaches the account, and how a
 * write another computer may have raced is confirmed after a sync. Every rule
 * of the merged view is in `snapshot.local.automations`, so every reader sees
 * one list.
 *
 * What it guarantees, and why:
 *
 * - **Nothing is lost.** A rule only leaves `.ade/local.yaml` once the account
 *   holds it. Two computers that file different rules under one id in the
 *   same moment both keep theirs: a sync shows which one the account kept,
 *   and the other is filed again under a new id.
 * - **One computer runs a rule.** Only its home (device and checkout) starts
 *   it, and only while it has heard from the account within its lease
 *   (`AUTOMATION_HOME_LEASE_MS`); a new home waits past that lease after a
 *   change (`AUTOMATION_HOME_HANDOVER_MS`), so an old home that missed the
 *   change (offline, signed out) has stopped by then.
 * - **A stale writer cannot undo or delete.** A generic config save may only
 *   add a new rule; edits, deletes and moves go through `save`/`remove`.
 * - **An older ADE cannot strip a newer rule.** A rule this ADE cannot read
 *   whole is shown but never run or edited here.
 */

/** A lost race is only a race when the two writes were this close together. */
const RACE_WINDOW_MS = 10 * 60_000;

/**
 * A rule as it goes to ADE Cloud: its runs make their lanes there
 * (`execution.cloud`), and each schedule names the zone it is read in (this
 * computer's, unless it has one), so every brain compiles the same rule.
 */
function forCloudHome(rule: ConfigAutomationRule): ConfigAutomationRule {
  const zone = localTimeZone();
  const withZone = (trigger: AutomationTrigger): AutomationTrigger =>
    trigger.type === "schedule" && !trigger.timezone ? { ...trigger, timezone: zone } : trigger;
  return {
    ...rule,
    ...(rule.triggers ? { triggers: rule.triggers.map(withZone) } : {}),
    ...(rule.trigger ? { trigger: withZone(rule.trigger) } : {}),
    ...(rule.execution ? { execution: { ...rule.execution, cloud: rule.execution.cloud ?? {} } } : {}),
  };
}

type Note = { needsNewerAde?: true; localReason?: AutomationRuleLocalReason; accountRunCount?: number };

type AccountRule = {
  rule: ConfigAutomationRule;
  needsNewerAde: boolean;
  runCount?: number;
  version?: string;
};

export type AutomationRuleAccountSync = ReturnType<typeof createAutomationRuleAccountSync>;

export function createAutomationRuleAccountSync(args: {
  store: AutomationRuleAccountStore;
  coerceRule: (value: unknown) => ConfigAutomationRule | null;
  coerceHome: (value: unknown) => AutomationRuleHome | undefined;
  /** A rule's problems judged alone, as a config save would judge it. */
  ruleProblems: (rule: ConfigAutomationRule) => string[];
  readFileRules: () => ConfigAutomationRule[];
  /** Replace the file's rules, without diverting them anywhere. */
  writeFileRules: (rules: ConfigAutomationRule[]) => void;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => number;
}) {
  const { store, logger } = args;
  const now = args.now ?? Date.now;
  let cache: { fingerprint: string; rules: AccountRule[] } | null = null;

  /** A rule's content as stored: coerced, without its home. */
  const content = (rule: ConfigAutomationRule): ConfigAutomationRule => {
    const { home: _home, ...rest } = args.coerceRule(rule) ?? rule;
    return rest;
  };
  const sameContent = (a: ConfigAutomationRule, b: ConfigAutomationRule): boolean => stableJson(content(a)) === stableJson(content(b));

  /** The account's rules for this repository, or null when there are none to have (no remote). */
  const readAccount = (): AccountRule[] | null => {
    const read = store.read();
    if (!read) return null;
    if (cache?.fingerprint === read.fingerprint) return cache.rules;
    const rules: AccountRule[] = [];
    const seen = new Set<string>();
    for (const row of read.rows) {
      const coerced = args.coerceRule(row.value);
      if (!coerced?.id || seen.has(coerced.id) || isChatScopedAutomationRule(coerced)) continue;
      const { home: _ignored, ...stored } = coerced;
      // A value this ADE does not read back exactly was written by a newer
      // ADE (a trigger, step or field it does not know). Editing it here
      // would strip what it cannot see, and running it would run the wrong
      // thing, so it is shown paused and left alone.
      let needsNewerAde = stableJson(stored) !== stableJson(row.value);
      const home = args.coerceHome(row.home);
      let rule: ConfigAutomationRule = { ...stored, ...(home ? { home } : {}) };
      if (needsNewerAde) rule = { ...rule, enabled: false };
      if (args.ruleProblems(rule).length > 0) {
        needsNewerAde = true;
        rule = { ...rule, enabled: false };
        const problems = args.ruleProblems(rule);
        if (problems.length > 0) {
          logger.warn("projectConfig.account_rule_skipped", { automationId: rule.id, problems: problems.slice(0, 3) });
          continue;
        }
      }
      seen.add(rule.id);
      rules.push({ rule, needsNewerAde, ...(row.runCount ? { runCount: row.runCount } : {}), ...(row.version ? { version: row.version } : {}) });
    }
    cache = { fingerprint: read.fingerprint, rules };
    return rules;
  };

  const accountRule = (id: string): AccountRule | undefined => readAccount()?.find((entry) => entry.rule.id === id);

  /** Why a file rule is not in the account, or undefined when it can move now. */
  const localReasonFor = (rule: ConfigAutomationRule): AutomationRuleLocalReason => {
    if (isChatScopedAutomationRule(rule)) return "chat";
    if (!store.scope()) return "no-remote";
    if (!fitsInAccount(content(rule))) return "too-large";
    const user = store.accountUserId();
    if (!user) return "signed-out";
    if (belongsToAnotherAccount(rule.id)) return "other-account";
    return "pending";
  };

  /** A rule saved here while another account was signed in: it waits for that account. */
  const belongsToAnotherAccount = (ruleId: string): boolean => {
    const owner = store.offlineSave(ruleId)?.owner;
    const user = store.accountUserId();
    return Boolean(owner && user && owner !== user);
  };

  /** True when a rule may be filed in the account now. */
  const canFollow = (rule: ConfigAutomationRule): boolean => {
    if (isChatScopedAutomationRule(rule) || !store.scope()) return false;
    return fitsInAccount(content(rule));
  };

  const suffixForHere = (): string =>
    (store.thisDeviceId() ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase() || "here";

  const freeId = (base: string, taken: Set<string>): string => {
    const suffix = suffixForHere();
    let id = `${base}-${suffix}`;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${suffix}-${n}`;
    taken.add(id);
    return id;
  };

  /** Home first, then the rule: a home with no rule is ignored, a rule with no home would run nowhere. */
  const fileInAccount = (rule: ConfigAutomationRule, home: AutomationRuleHome | null): boolean => {
    if (home && !store.writeHome(rule.id, home)) return false;
    return store.writeRule(content(rule) as ConfigAutomationRule & Record<string, unknown>);
  };

  const resolveHome = (
    requested: AutomationRuleHome | "this-computer" | "ade-cloud",
    current: AutomationRuleHome | undefined,
  ): AutomationRuleHome => {
    let home: AutomationRuleHome | null;
    if (requested === "ade-cloud" || (typeof requested === "object" && isAdeCloudHome(requested))) {
      home = { kind: "cloud", deviceId: ADE_CLOUD_HOME_DEVICE_ID, name: ADE_CLOUD_HOME_NAME, chosenAt: new Date(now()).toISOString(), checkout: null };
    } else if (requested === "this-computer") {
      home = store.thisComputerHome();
      if (!home) throw new Error("This computer is still being identified. Try again in a moment.");
    } else {
      home = args.coerceHome({ ...requested, chosenAt: new Date(now()).toISOString() }) ?? null;
      if (!home) throw new Error("A rule's computer needs a device id and a name.");
      // The checkout on another computer is that computer's to claim.
      home = { ...home, checkout: home.deviceId === store.thisDeviceId() ? store.checkout : null };
    }
    if (!home) throw new Error("A rule's computer needs a device id and a name.");
    // Choosing the same computer again keeps the home as it is, wait
    // included: dropping an active handover would let it start before the
    // old home's lease runs out.
    if (current && current.deviceId === home.deviceId) {
      return { ...current, checkout: home.checkout ?? current.checkout ?? null };
    }
    const { previousDeviceId: _p, ...base } = home;
    return { ...base, ...(current ? { previousDeviceId: current.deviceId } : {}) };
  };

  return {
    /** Changes whenever the account's rules for this repository do. */
    fingerprint(): string | null {
      return store.read()?.fingerprint ?? null;
    },

    /**
     * Rules whose home is ADE Cloud (`onCloud`), and rules whose home just
     * left it for a computer (`onCloud: false`, so the server's copy goes),
     * with the version ADE Cloud compares. A rule this ADE can't read whole
     * is never sent: a newer brain sends it.
     */
    cloudHomes(): Array<{ rule: ConfigAutomationRule; version: string; onCloud: boolean }> {
      const out: Array<{ rule: ConfigAutomationRule; version: string; onCloud: boolean }> = [];
      for (const entry of readAccount() ?? []) {
        const home = entry.rule.home;
        if (!home) continue;
        const onCloud = isAdeCloudHome(home);
        if (!onCloud && home.previousDeviceId !== ADE_CLOUD_HOME_DEVICE_ID) continue;
        if (onCloud && entry.needsNewerAde) continue;
        out.push({ rule: entry.rule, version: entry.version ?? home.chosenAt, onCloud });
      }
      return out;
    },

    /**
     * The merged rule list: the account's rules, then the file's. A file
     * rule with the id of an account rule is a newer copy saved while signed
     * out, and wins.
     */
    merge(fileRules: ConfigAutomationRule[]): { rules: ConfigAutomationRule[]; notes: Map<string, Note> } {
      const notes = new Map<string, Note>();
      const fileIds = new Set(fileRules.map((rule) => rule.id));
      const account = readAccount() ?? [];
      const rules: ConfigAutomationRule[] = [];
      const runCounts = new Map(account.filter((entry) => entry.runCount).map((entry) => [entry.rule.id, entry.runCount!]));
      for (const entry of account) {
        if (fileIds.has(entry.rule.id)) continue;
        notes.set(entry.rule.id, {
          ...(entry.needsNewerAde ? { needsNewerAde: true as const } : {}),
          ...(entry.runCount ? { accountRunCount: entry.runCount } : {}),
        });
        rules.push(structuredClone(entry.rule));
      }
      for (const rule of fileRules) {
        notes.set(rule.id, {
          localReason: localReasonFor(rule),
          ...(runCounts.has(rule.id) ? { accountRunCount: runCounts.get(rule.id)! } : {}),
        });
        rules.push(rule);
      }
      return { rules, notes };
    },

    /** Mark which rules this computer and checkout run, and why a rule stays here. */
    stamp(effective: AutomationRule[], notes: Map<string, Note>): void {
      const deviceId = store.thisDeviceId();
      let leaseFresh: boolean | null = null;
      for (const rule of effective) {
        const note = notes.get(rule.id);
        if (note?.localReason) rule.localReason = note.localReason;
        if (note?.accountRunCount) rule.accountRunCount = note.accountRunCount;
        if (rule.home) {
          rule.runsHere = deviceId != null
            && rule.home.deviceId === deviceId
            && rule.home.checkout === store.checkout;
          if (rule.runsHere) {
            leaseFresh ??= store.leaseFresh();
            if (!leaseFresh) rule.homeOutOfTouch = true;
          }
          if (rule.home.previousDeviceId && rule.home.previousDeviceId !== rule.home.deviceId) {
            const startsAt = Date.parse(rule.home.chosenAt) + AUTOMATION_HOME_HANDOVER_MS;
            if (Number.isFinite(startsAt)) rule.homeStartsAt = new Date(startsAt).toISOString();
          }
        }
        if (note?.needsNewerAde) {
          rule.needsNewerAde = true;
          rule.runsHere = false;
        }
      }
    },

    /**
     * What a generic config save may do to account rules: add a new one,
     * nothing else. A caller that read the snapshot a minute ago carries a
     * stale copy of every rule; letting it win would undo another computer's
     * edit, and leaving a rule out would delete it. A rule some computer
     * deleted does not come back.
     */
    divert(candidateRules: ConfigAutomationRule[]): ConfigAutomationRule[] {
      if (!store.scope()) return candidateRules;
      const accountIds = new Set((readAccount() ?? []).map((entry) => entry.rule.id));
      const fileIds = new Set(args.readFileRules().map((rule) => rule.id));
      const deleted = store.deletedRuleKeys();
      const here = store.thisComputerHome();
      const kept: ConfigAutomationRule[] = [];
      for (const rule of candidateRules) {
        if (!canFollow(rule) || fileIds.has(rule.id)) {
          kept.push(rule);
          continue;
        }
        if (accountIds.has(rule.id) || deleted.has(automationRuleAccountKey(rule.id))) continue;
        // Before the first sync this computer may not see a rule another one
        // filed under this id; it waits in the file and moves after the sync.
        if (here && store.signedIn() && store.hasSynced() && fileInAccount(rule, here)) {
          store.addPending({ ruleId: rule.id, rule: content(rule) as ConfigAutomationRule & Record<string, unknown>, home: here });
          continue;
        }
        store.noteOfflineSave(rule.id, "new");
        kept.push(rule);
      }
      return kept;
    },

    /**
     * Move the file's rules into the account. Runs once the store has synced
     * (so another computer's rules are known) and after every sign-in.
     *
     * - A copy saved while signed out (it carries `home`) replaces the
     *   account's content and keeps the account's home, unless it belongs to
     *   another account, which keeps it here until that account is back.
     * - An identical rule the account already holds is dropped: its home runs it.
     * - A different rule that only shares the id is filed under a new id.
     */
    migrate(): { moved: number; renamed: string[] } {
      const here = store.thisComputerHome();
      const user = store.accountUserId();
      // Only once this computer has synced: an unsynced copy may lack a rule
      // another computer filed under the same id, which this one would overwrite.
      if (!store.scope() || !here || !user || !store.hasSynced()) return { moved: 0, renamed: [] };
      const fileRules = args.readFileRules();
      if (!fileRules.some(canFollow)) return { moved: 0, renamed: [] };
      const account = new Map((readAccount() ?? []).map((entry) => [entry.rule.id, entry]));
      const taken = new Set([...account.keys(), ...fileRules.map((rule) => rule.id)]);
      const kept: ConfigAutomationRule[] = [];
      const renamed: string[] = [];
      const movedIds: string[] = [];
      const deleted = store.deletedRuleStamps();
      for (const rule of fileRules) {
        if (!canFollow(rule) || belongsToAnotherAccount(rule.id)) {
          kept.push(rule);
          continue;
        }
        const offline = store.offlineSave(rule.id);
        const existing = account.get(rule.id);
        if (existing?.needsNewerAde) {
          // Never overwrite what this ADE cannot read whole.
          kept.push(rule);
          continue;
        }
        // A new rule that waited here takes the path below like a legacy
        // rule: an id another computer already used is renamed, not taken.
        if (rule.home || offline?.kind === "edit") {
          // Saved while signed out: an edit of an account rule. If another
          // computer deleted the rule after this edit was made, the delete
          // stands; an edit made after the delete brings the rule back.
          const deletedAt = !existing ? deleted.get(automationRuleAccountKey(rule.id)) : undefined;
          if (deletedAt && offline && Date.parse(deletedAt) > Date.parse(offline.at)) {
            movedIds.push(rule.id);
            continue;
          }
          const home = existing?.rule.home ? null : rule.home ?? here;
          if (!fileInAccount(rule, home)) {
            kept.push(rule);
            continue;
          }
          // A new rule that waited here can race another computer's like any other.
          if (!existing) store.addPending({ ruleId: rule.id, rule: content(rule) as ConfigAutomationRule & Record<string, unknown>, home: home ?? here });
          movedIds.push(rule.id);
          continue;
        }
        let target = rule;
        if (existing) {
          if (sameContent(existing.rule, rule)) {
            movedIds.push(rule.id);
            continue;
          }
          const id = freeId(rule.id, taken);
          renamed.push(`${rule.id} -> ${id}`);
          target = { ...rule, id };
        }
        if (!fileInAccount(target, here)) {
          kept.push(rule);
          continue;
        }
        store.addPending({ ruleId: target.id, rule: content(target) as ConfigAutomationRule & Record<string, unknown>, home: here });
        movedIds.push(rule.id);
      }
      if (movedIds.length > 0) {
        args.writeFileRules(kept);
        store.clearOfflineSave(movedIds);
        logger.info("projectConfig.automations_moved_to_account", { moved: movedIds.length, renamed });
      }
      return { moved: movedIds.length, renamed };
    },

    /**
     * After a sync: claim rules homed on this computer with no checkout yet
     * (a change of home made on another computer), and, when `confirmed`
     * (every local write reached the account), settle the writes another
     * computer could have raced.
     */
    reconcile(options: { confirmed: boolean }): { claimed: number; readded: string[] } {
      if (!store.scope() || !store.signedIn()) return { claimed: 0, readded: [] };
      const deviceId = store.thisDeviceId();
      let claimed = 0;
      const ownName = store.thisComputerHome()?.name ?? null;
      for (const entry of readAccount() ?? []) {
        const home = entry.rule.home;
        if (!deviceId || !home || home.deviceId !== deviceId) continue;
        // Two checkouts in one brain share one store, so the first to claim
        // wins and the other reads the claim straight back.
        if (!home.checkout) {
          if (store.writeHome(entry.rule.id, { ...home, checkout: store.checkout, ...(ownName ? { name: ownName } : {}) })) claimed += 1;
        } else if (home.checkout === store.checkout && ownName && home.name !== ownName) {
          // Other computers show this name; keep it the registered one.
          if (store.writeHome(entry.rule.id, { ...home, name: ownName })) claimed += 1;
        }
      }
      if (claimed > 0) cache = null;
      // Runs counted while signed out go up now, so a later home's limit holds.
      for (const pending of store.pendingRunCounts()) {
        const current = accountRule(pending.ruleId);
        if (!current) {
          store.clearPendingRunCount(pending.ruleId);
          continue;
        }
        if ((current.runCount ?? 0) >= pending.count || store.writeRunCount(pending.ruleId, pending.count)) {
          store.clearPendingRunCount(pending.ruleId);
        }
      }
      const readded: string[] = [];
      if (!options.confirmed) return { claimed, readded };
      const user = store.accountUserId();
      const deleted = store.deletedRuleKeys();
      const settled: string[] = [];
      const taken = new Set((readAccount() ?? []).map((entry) => entry.rule.id));
      for (const pending of store.pending()) {
        // Another account's write waits for that account: switching accounts
        // drops the store's unsent writes, and this is how they come back.
        if (pending.accountUserId !== user) continue;
        const current = accountRule(pending.ruleId);
        const ours = { ...(args.coerceRule(pending.rule) ?? (pending.rule as ConfigAutomationRule)), id: pending.ruleId };
        if (!current) {
          if (deleted.has(automationRuleAccountKey(pending.ruleId))) settled.push(pending.ruleId);
          else fileInAccount(ours, pending.home);
          continue;
        }
        settled.push(pending.ruleId);
        if (sameContent(current.rule, ours)) continue;
        const theirHome = current.rule.home;
        if (!theirHome || theirHome.deviceId === pending.home.deviceId) continue;
        const gap = Math.abs(Date.parse(theirHome.chosenAt) - Date.parse(pending.at));
        if (!Number.isFinite(gap) || gap > RACE_WINDOW_MS) continue;
        // Another computer filed a different rule under this id at the same
        // moment, and the account kept theirs. Ours goes back under a new id.
        const id = freeId(pending.ruleId, taken);
        const home = store.thisComputerHome() ?? pending.home;
        if (fileInAccount({ ...ours, id }, home)) {
          store.addPending({ ruleId: id, rule: content({ ...ours, id }) as ConfigAutomationRule & Record<string, unknown>, home });
          readded.push(`${pending.ruleId} -> ${id}`);
        }
      }
      store.dropPending(settled);
      if (readded.length > 0) logger.warn("projectConfig.automation_rule_race_readded", { readded });
      return { claimed, readded };
    },

    /**
     * Create or replace one rule. Returns false when the rule is not one for
     * the account (chat, no remote, a new rule too large or saved while
     * signed out): the caller saves it in `.ade/local.yaml`.
     */
    save(
      saved: ConfigAutomationRule,
      options: { home?: AutomationRuleHome | "this-computer" | "ade-cloud" | null },
    ): { handled: true } | { handled: false; keepHome?: AutomationRuleHome } {
      const existing = accountRule(saved.id);
      if (existing?.needsNewerAde) {
        throw new Error(`'${existing.rule.name ?? saved.id}' was made with a newer ADE. Update ADE on this computer to change it.`);
      }
      // ADE Cloud as the home (asked for now, or kept): the rule must be one its server can run.
      const toCloud = options.home === "ade-cloud" || (typeof options.home === "object" && isAdeCloudHome(options.home));
      const staysOnCloud = !options.home && isAdeCloudHome(existing?.rule.home);
      let rule = saved;
      if (toCloud || staysOnCloud) {
        if (isChatScopedAutomationRule(saved) || !store.scope()) {
          throw new Error("Only a rule in a repository with a GitHub remote can run on ADE Cloud.");
        }
        rule = forCloudHome(saved);
        const problem = automationCloudHomeProblem(rule);
        if (problem) throw new Error(problem);
        if (!store.signedIn()) throw new Error("Sign in to ADE to run this automation on ADE Cloud.");
      }
      if (isChatScopedAutomationRule(rule) || !store.scope()) return { handled: false };
      const fileCopy = args.readFileRules().find((entry) => entry.id === rule.id);
      if (belongsToAnotherAccount(rule.id)) {
        // Saved for another account: it stays here until that account is back.
        if (options.home) throw new Error("This automation belongs to another ADE account. Sign in to that account to change which computer runs it.");
        return { handled: false, keepHome: fileCopy?.home };
      }
      // A rule bound for ADE Cloud is never kept in the file: there it would run on this computer.
      const cloudRefused = new Error("ADE couldn't save this automation to your ADE account yet, so it can't move to ADE Cloud. Try again in a moment.");
      if (!existing) {
        if (toCloud && (!canFollow(rule) || !store.hasSynced())) throw cloudRefused;
        // A new rule, or one still waiting in the file: filed in the account
        // now when it can be, else kept in the file to move later.
        if (!canFollow(rule)) return { handled: false };
        // Waiting in the file (signed out, not synced yet): record whose it
        // is, so it never moves into another account.
        if (!store.signedIn() || !store.hasSynced()) {
          store.noteOfflineSave(rule.id, "new");
          return { handled: false };
        }
        const home = options.home ? resolveHome(options.home, undefined) : store.thisComputerHome();
        if (!home || !fileInAccount(rule, home)) {
          if (toCloud) throw cloudRefused;
          store.noteOfflineSave(rule.id, "new");
          return { handled: false };
        }
        store.addPending({ ruleId: rule.id, rule: content(rule) as ConfigAutomationRule & Record<string, unknown>, home });
        if (fileCopy) args.writeFileRules(args.readFileRules().filter((entry) => entry.id !== rule.id));
        return { handled: true };
      }
      if (!fitsInAccount(content(rule))) {
        const size = Math.ceil((JSON.stringify(content(rule)) ?? "").length / 1000);
        throw new Error(`This automation is too large to follow your ADE account (${size} KB; the limit is 16 KB). Shorten its prompt or steps.`);
      }
      const currentHome = existing.rule.home;
      const requestedHome = options.home ? resolveHome(options.home, currentHome) : null;
      if (!store.signedIn()) {
        if (requestedHome && requestedHome.deviceId !== currentHome?.deviceId) {
          throw new Error("Sign in to ADE to change which computer runs this automation.");
        }
        // Kept here with its home until sign-in; the home keeps running the
        // last synced version meanwhile.
        store.noteOfflineSave(rule.id, "edit");
        return { handled: false, keepHome: currentHome ?? store.thisComputerHome() ?? undefined };
      }
      const homeToWrite = requestedHome ?? (currentHome ? null : store.thisComputerHome());
      // Unchanged content is not written again: a change of home made from a
      // computer that has not seen another computer's edit yet must not undo it.
      const ok = sameContent(existing.rule, rule)
        ? !homeToWrite || store.writeHome(rule.id, homeToWrite)
        : fileInAccount(rule, homeToWrite);
      if (!ok) {
        if (toCloud || staysOnCloud) throw cloudRefused;
        store.noteOfflineSave(rule.id, "edit");
        return { handled: false, keepHome: currentHome ?? undefined };
      }
      if (fileCopy) args.writeFileRules(args.readFileRules().filter((entry) => entry.id !== rule.id));
      store.clearOfflineSave([rule.id]);
      return { handled: true };
    },

    /**
     * Record runs counted so far for a rule with a run limit, so the limit
     * holds when the rule moves. Only a higher count is written.
     */
    recordRunCount(ruleId: string, count: number): void {
      const current = accountRule(ruleId);
      if (!current || (current.runCount ?? 0) >= count) return;
      store.writeRunCount(ruleId, count);
    },

    /** Delete a rule from the account. Undefined when the account does not hold it. */
    remove(ruleId: string): boolean | undefined {
      const read = store.read();
      if (!read) return undefined;
      const inAccount = read.rows.some((row) => {
        const id = row.value && typeof row.value === "object" ? (row.value as { id?: unknown }).id : null;
        return typeof id === "string" && id.trim() === ruleId;
      });
      if (!inAccount) return undefined;
      if (!store.remove(ruleId)) {
        throw new Error("This automation follows your ADE account. Sign in to ADE to delete it.");
      }
      store.dropPending([ruleId]);
      store.clearOfflineSave([ruleId]);
      return true;
    },
  };
}
