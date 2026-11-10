import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { AutomationRuleHome } from "../../../shared/types";
import type { Logger } from "../logging/logger";

/**
 * Automation rules that follow the account, per repository.
 *
 * Each rule is one row in the brain's account settings store, filed under the
 * repository (`repo:<host>/<owner>/<repo>`, the scope lane templates and the
 * CTO home use) at `automations.rule.<id>`. One row per rule, not one list:
 * the store keeps the strictly newer stamp per key, so a whole-list value
 * saved on one computer would drop a rule another computer had just added.
 *
 * Every rule names the one computer that runs it (`home`); other computers
 * show and edit it but never start it. Rules stay out of the account when
 * there is nothing another computer could match them by (no remote) and when
 * they belong to one chat (`scope.sessionId`), whose chat lives on one
 * computer. Those keep living in `.ade/local.yaml`.
 */

/** The slice of the account settings store this module needs. */
export type AutomationRuleAccountBackend = {
  get(scope: string, key: string): unknown;
  /** False when the write was refused (signed out, account switched). */
  set(scope: string, key: string, value: unknown): unknown;
  remove(scope: string, key: string): unknown;
  list(scope?: string): ReadonlyArray<{ key: string; value: unknown; updatedAt: string }>;
  /** Keys some computer deleted. Optional; without it a stale copy can come back. */
  deletedKeys?(scope: string): ReadonlyArray<{ key: string; updatedAt: string }>;
};

export const AUTOMATION_RULE_KEY_PREFIX = "automations.rule.";

// The relay takes keys of `[A-Za-z0-9._-]`, up to 200 characters.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

/** The account key a rule is stored under. Ids the relay cannot carry are hashed. */
export function automationRuleAccountKey(ruleId: string): string {
  const id = ruleId.trim();
  if (SAFE_ID.test(id)) return `${AUTOMATION_RULE_KEY_PREFIX}${id}`;
  return `${AUTOMATION_RULE_KEY_PREFIX}h.${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** A rule armed from one chat (auto-handoff and the like): it stays with that chat's computer. */
export function isChatScopedAutomationRule(rule: { scope?: { sessionId?: string | null } | null }): boolean {
  return typeof rule.scope?.sessionId === "string" && rule.scope.sessionId.trim().length > 0;
}

export type AutomationRuleAccountStore = ReturnType<typeof createAutomationRuleAccountStore>;

export function createAutomationRuleAccountStore(args: {
  backend: AutomationRuleAccountBackend;
  /** The canonical origin URL; read on every call, so cache it in the caller. */
  readOriginUrl: () => string | null;
  /** This computer's sync device id and name. The id may be unknown early on. */
  thisComputer: () => { deviceId: string | null; name: string | null };
  /**
   * Whether the account store will answer. A signed-out store hides every
   * row; without a copy, this computer would stop running its own rules.
   */
  isSignedIn?: () => boolean;
  /**
   * This computer's copy of the account's rules for the repository, written
   * whenever they change and read (only) while signed out.
   */
  signedOutCopyPath?: string | null;
  logger?: Pick<Logger, "warn"> | null;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  let copiedFingerprint: string | null = null;

  const readSignedOutCopy = (where: string): { fingerprint: string; values: unknown[] } | null => {
    if (!args.signedOutCopyPath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(args.signedOutCopyPath, "utf8")) as {
        scope?: unknown;
        fingerprint?: unknown;
        values?: unknown;
      };
      if (parsed.scope !== where || typeof parsed.fingerprint !== "string" || !Array.isArray(parsed.values)) return null;
      return { fingerprint: `signed-out|${parsed.fingerprint}`, values: parsed.values };
    } catch {
      return null;
    }
  };

  const writeSignedOutCopy = (where: string, read: { fingerprint: string; values: unknown[] }): void => {
    if (!args.signedOutCopyPath || copiedFingerprint === read.fingerprint) return;
    try {
      fs.mkdirSync(path.dirname(args.signedOutCopyPath), { recursive: true });
      const tmp = `${args.signedOutCopyPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ scope: where, fingerprint: read.fingerprint, values: read.values }), { mode: 0o600 });
      fs.renameSync(tmp, args.signedOutCopyPath);
      copiedFingerprint = read.fingerprint;
    } catch (error) {
      args.logger?.warn("automations.account_rules.copy_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scope = (): string | null => {
    try {
      return accountRepoScopeKey(args.readOriginUrl());
    } catch (error) {
      args.logger?.warn("automations.account_rules.origin_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  // Read on every config read (to mark which rules run here), so it is kept
  // once known: a computer's sync device id does not change while ADE runs.
  let knownDevice: { deviceId: string; name: string | null } | null = null;
  const thisDevice = (): { deviceId: string | null; name: string | null } => {
    if (knownDevice) return knownDevice;
    try {
      const device = args.thisComputer();
      const deviceId = device.deviceId?.trim() || null;
      const name = device.name?.trim() || null;
      if (deviceId) knownDevice = { deviceId, name };
      return { deviceId, name };
    } catch {
      return { deviceId: null, name: null };
    }
  };

  return {
    /** The repository scope rules are filed under, or null when the project has no usable remote. */
    scope,

    /** This computer's sync device id, or null while it is not known. */
    thisDeviceId(): string | null {
      return thisDevice().deviceId;
    },

    /** This computer as a rule's home, or null while its device id is not known. */
    thisComputerHome(): AutomationRuleHome | null {
      const device = thisDevice();
      if (!device.deviceId) return null;
      return { deviceId: device.deviceId, name: device.name ?? "This computer", chosenAt: new Date(now()).toISOString() };
    },

    /**
     * Every stored rule value in this repository's scope, plus a fingerprint
     * of the rows (keys and stamps) so a caller can cache what it derives.
     * Null when the project has no remote.
     */
    read(): { fingerprint: string; values: unknown[] } | null {
      const where = scope();
      if (!where) return null;
      if (args.isSignedIn && !args.isSignedIn()) {
        // Shown and run as they were; edits wait in `.ade/local.yaml`.
        return readSignedOutCopy(where) ?? { fingerprint: "signed-out", values: [] };
      }
      let rows: ReadonlyArray<{ key: string; value: unknown; updatedAt: string }>;
      try {
        rows = args.backend.list(where);
      } catch (error) {
        args.logger?.warn("automations.account_rules.read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return { fingerprint: "unreadable", values: [] };
      }
      const values: unknown[] = [];
      let fingerprint = where;
      for (const row of rows) {
        if (!row.key.startsWith(AUTOMATION_RULE_KEY_PREFIX)) continue;
        fingerprint += `|${row.key}@${row.updatedAt}`;
        values.push(row.value);
      }
      writeSignedOutCopy(where, { fingerprint, values });
      return { fingerprint, values };
    },

    /** Ids whose row some computer deleted, as keys. */
    deletedKeys(): Set<string> {
      const where = scope();
      if (!where || !args.backend.deletedKeys) return new Set();
      try {
        return new Set(
          args.backend.deletedKeys(where)
            .map((entry) => entry.key)
            .filter((key) => key.startsWith(AUTOMATION_RULE_KEY_PREFIX)),
        );
      } catch {
        return new Set();
      }
    },

    /** Store one rule. False when the account refused it (signed out) or there is no remote. */
    write(rule: { id: string } & Record<string, unknown>): boolean {
      const where = scope();
      if (!where) return false;
      try {
        return args.backend.set(where, automationRuleAccountKey(rule.id), rule) !== false;
      } catch (error) {
        args.logger?.warn("automations.account_rules.write_failed", {
          automationId: rule.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    /** Delete one rule on every computer. False when the account refused it. */
    remove(ruleId: string): boolean {
      const where = scope();
      if (!where) return false;
      try {
        return args.backend.remove(where, automationRuleAccountKey(ruleId)) !== false;
      } catch (error) {
        args.logger?.warn("automations.account_rules.remove_failed", {
          automationId: ruleId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
}
