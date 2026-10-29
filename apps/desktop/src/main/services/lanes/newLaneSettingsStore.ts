import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACCOUNT_SCOPE_ALL, accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import {
  DEFAULT_LANE_START,
  normalizeNewLaneDefaults,
  type NewLaneDefaults,
} from "../../../shared/laneStart";
import { NO_DEFAULT_LANE_TEMPLATE } from "../../../shared/types";
import type { LaneTemplate, NewLaneSettingsScope, ProjectConfigSnapshot } from "../../../shared/types";

/** The slice of the brain's account settings store this module needs. */
export type NewLaneAccountStore = {
  get(scope: string, key: string): unknown;
  set(scope: string, key: string, value: unknown): unknown;
};

/**
 * A stand-in for the account store on a brain that has none (a `--no-sync`
 * dev brain, a signed-out machine): the same rows in one JSON file under the
 * project's `.ade` folder, so choices still save, on this computer only.
 */
export function createFileNewLaneAccountStore(filePath: string): NewLaneAccountStore {
  const readAll = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  return {
    get: (scope, key) => readAll()[`${scope}|${key}`],
    set: (scope, key, value) => {
      const next = { ...readAll(), [`${scope}|${key}`]: value };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, filePath);
      return true;
    },
  };
}

/**
 * The per-computer settings ADE used before new-lane settings followed the
 * account, read from the project config: the fallback until the account holds
 * a value.
 */
export function legacyNewLaneSettingsFromConfig(snapshot: ProjectConfigSnapshot): {
  baseSource: "local" | "remote" | null;
  defaultTemplateId: string | null;
  templates: LaneTemplate[] | null;
} {
  const defaultTemplate = snapshot.effective.defaultLaneTemplate;
  const localIds = new Set((snapshot.local.laneTemplates ?? []).map((template) => template.id));
  const localTemplates = (snapshot.effective.laneTemplates ?? []).filter((template) => localIds.has(template.id));
  return {
    baseSource: snapshot.effective.git?.newLaneBaseSource ?? null,
    defaultTemplateId: defaultTemplate && defaultTemplate !== NO_DEFAULT_LANE_TEMPLATE ? defaultTemplate : null,
    templates: localTemplates.length > 0 ? localTemplates : null,
  };
}

const DEFAULTS_KEY = "lanes.newLaneDefaults";
const TEMPLATES_KEY = "lanes.templates";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asTemplates(value: unknown): LaneTemplate[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (entry): entry is LaneTemplate => isRecord(entry) && typeof entry.id === "string" && entry.id.trim().length > 0
      && typeof entry.name === "string",
  );
}

/**
 * Where a project's new-lane settings live: its defaults (where new lanes
 * start, which template they get) and its lane templates.
 *
 * They are account settings filed under the repository (`repo:<origin>`), so
 * changing them on one computer changes them on every computer and phone that
 * opens the same repository. A project with no remote has no identity another
 * computer could match, so its settings are filed under a key derived from
 * this checkout's path and in practice stay on this computer.
 *
 * Before anything is stored, the defaults fall back to the project's old
 * per-computer settings (`git.newLaneBaseSource`, `defaultLaneTemplate`,
 * `laneTemplates` in `.ade/local.yaml`), so nobody loses a choice they made.
 */
export function createNewLaneSettingsStore(args: {
  projectRoot: string;
  store: NewLaneAccountStore | null;
  /** False when `store` is the per-computer file stand-in rather than the account. */
  accountBacked?: boolean;
  readOriginUrl: () => string | null;
  legacy: () => {
    baseSource?: "local" | "remote" | null;
    defaultTemplateId?: string | null;
    templates?: LaneTemplate[] | null;
  };
}) {
  const location = (): { scope: string; suffix: string; kind: NewLaneSettingsScope["kind"]; repo: string | null } => {
    let origin: string | null = null;
    try {
      origin = args.readOriginUrl();
    } catch {
      origin = null;
    }
    const repoScope = accountRepoScopeKey(origin);
    if (repoScope) {
      return {
        scope: repoScope,
        suffix: "",
        kind: args.accountBacked === false ? "this-computer" : "account-repo",
        repo: repoScope.slice("repo:".length),
      };
    }
    const hash = createHash("sha256").update(args.projectRoot).digest("hex").slice(0, 16);
    return { scope: ACCOUNT_SCOPE_ALL, suffix: `.local.${hash}`, kind: "this-computer", repo: null };
  };

  const read = (key: string): unknown => {
    if (!args.store) return undefined;
    const where = location();
    try {
      return args.store.get(where.scope, `${key}${where.suffix}`);
    } catch {
      return undefined;
    }
  };

  const write = (key: string, value: unknown): void => {
    if (!args.store) throw new Error("Account settings aren't available on this computer yet. Sign in to ADE and try again.");
    const where = location();
    args.store.set(where.scope, `${key}${where.suffix}`, value);
  };

  const legacyDefaults = (): NewLaneDefaults => {
    const legacy = args.legacy();
    return {
      start: { ...DEFAULT_LANE_START, bring: legacy.baseSource === "local" ? "local" : "pushed" },
      templateId: legacy.defaultTemplateId?.trim() || null,
    };
  };

  return {
    scope(): NewLaneSettingsScope {
      const where = location();
      return { kind: where.kind, repo: where.repo };
    },

    getDefaults(): NewLaneDefaults {
      const stored = read(DEFAULTS_KEY);
      return stored === undefined || stored === null ? legacyDefaults() : normalizeNewLaneDefaults(stored);
    },

    setDefaults(next: NewLaneDefaults): NewLaneDefaults {
      const normalized = normalizeNewLaneDefaults(next);
      write(DEFAULTS_KEY, normalized);
      return normalized;
    },

    /** The account copy of this project's templates; the old per-computer list until one is saved. */
    getTemplates(): LaneTemplate[] {
      return asTemplates(read(TEMPLATES_KEY)) ?? args.legacy().templates ?? [];
    },

    setTemplates(templates: LaneTemplate[]): void {
      write(TEMPLATES_KEY, templates);
    },
  };
}

export type NewLaneSettingsStore = ReturnType<typeof createNewLaneSettingsStore>;
