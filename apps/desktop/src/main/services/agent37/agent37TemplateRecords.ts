import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { normalizeAppPackageChannel } from "../../../shared/packageChannel";
import { agent37VaultFromBridge, type Agent37CredentialDeps } from "./agent37Credential";
import type {
  Agent37TemplateBuildRecord,
  Agent37TemplateContextFiles,
  Agent37TemplateRecordStore,
} from "./agent37TemplateBuilder";
import { AGENT37_TEMPLATE_BUILD_VAULT_KEY } from "./agent37VaultItems";

type Logger = {
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
};

/**
 * The ADE release this app is, for the template to install; null for a build
 * that is not a published release on the default channel (development, alpha),
 * which bakes the newest release and never replaces an existing template.
 */
export function releasedAdeVersion(): string | null {
  if (!app.isPackaged) return null;
  // The channel main.ts settles at startup (applyPackagedChannelDefaults), read
  // the same way every other main-process surface reads it.
  if (normalizeAppPackageChannel(process.env.ADE_PACKAGE_CHANNEL) === "alpha") return null;
  const version = app.getVersion().trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/**
 * `infra/agent37/template`: shipped as the `agent37-template` resource in a
 * packaged app (package.json `extraResources`), read from the checkout in
 * development.
 */
export async function readAgent37TemplateContext(): Promise<Agent37TemplateContextFiles> {
  const candidates = [
    ...(typeof process.resourcesPath === "string" ? [path.join(process.resourcesPath, "agent37-template")] : []),
    path.resolve(app.getAppPath(), "..", "..", "infra", "agent37", "template"),
  ];
  for (const dir of candidates) {
    try {
      const [dockerfile, entrypoint] = await Promise.all([
        fs.promises.readFile(path.join(dir, "Dockerfile"), "utf8"),
        fs.promises.readFile(path.join(dir, "ade-entrypoint.sh"), "utf8"),
      ]);
      return { dockerfile, entrypoint };
    } catch {
      // Try the next place.
    }
  }
  throw new Error("this copy of ADE is missing its machine template files. Reinstall ADE.");
}

const TEMPLATE_BUILD_MACHINE_KEY = "agent37.templateBuild.v1";

/** A damaged record reads as none (logged), so it can never stop builds for good. */
function parseBuildRecord(raw: string | null | undefined, logger: Logger): Agent37TemplateBuildRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Agent37TemplateBuildRecord>;
    if (parsed?.v !== 1 || typeof parsed.template !== "string" || typeof parsed.buildId !== "string") return null;
    if (typeof parsed.startedAt !== "number" || typeof parsed.adeVersion !== "string" || typeof parsed.contextHash !== "string") return null;
    return { v: 1, template: parsed.template, buildId: parsed.buildId, startedAt: parsed.startedAt, adeVersion: parsed.adeVersion, contextHash: parsed.contextHash, by: typeof parsed.by === "string" ? parsed.by : null };
  } catch (error) {
    logger.warn("agent37.template_record_unreadable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * The build-in-flight record: in the account vault, so every computer on the
 * account sees it. Reads use this computer's copy only when there is no
 * account vault (signed out); an unreachable vault is an error, not "none".
 */
export function templateBuildRecords(
  bridge: Parameters<typeof agent37VaultFromBridge>[0],
  credentials: Agent37CredentialDeps,
  machineStore: () => EncryptedFileCredentialStore,
  logger: Logger,
): Agent37TemplateRecordStore {
  const vault = () => (credentials.signedIn() ? agent37VaultFromBridge(bridge, AGENT37_TEMPLATE_BUILD_VAULT_KEY) : null);
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const local = <T>(what: string, run: () => T, fallback: T): T => {
    try {
      return run();
    } catch (error) {
      logger.warn("agent37.template_record_local_failed", { what, error: errorText(error) });
      return fallback;
    }
  };
  /** Runs a vault write; logs and answers false on a refusal or a throw. */
  const shared = async (what: string, run: () => Promise<boolean>): Promise<void> => {
    const ok = await run().catch((error: unknown) => {
      logger.warn("agent37.template_record_vault_failed", { what, error: errorText(error) });
      return null;
    });
    if (ok === false) logger.warn("agent37.template_record_vault_failed", { what, error: "refused" });
  };
  return {
    async read() {
      const store = vault();
      if (store) {
        // Signed in, the account is the authority. Unreachable is unknown:
        // the caller must not take this computer's copy as the whole answer.
        const got = await store.get().catch((error: unknown) => {
          logger.warn("agent37.template_record_vault_failed", { what: "read", error: errorText(error) });
          return { ok: false as const };
        });
        if (!got.ok) throw new Error("the account vault couldn't be read");
        // The account answered: its record, or its lack of one, is the whole
        // answer. This computer's copy holds our own last write even when the
        // vault refused it, and the builder reads "none" as "our claim did not
        // land"; the copy would hide exactly that.
        return parseBuildRecord(got.value, logger);
      }
      return parseBuildRecord(local("read", () => machineStore().getSync(TEMPLATE_BUILD_MACHINE_KEY), null), logger);
    },
    async write(record) {
      const raw = JSON.stringify(record);
      local("write", () => machineStore().setSync(TEMPLATE_BUILD_MACHINE_KEY, raw), undefined);
      const store = vault();
      if (store) await shared("write", () => store.set(raw));
    },
    async clear() {
      local("clear", () => machineStore().deleteSync(TEMPLATE_BUILD_MACHINE_KEY), undefined);
      const store = vault();
      if (store) await shared("clear", () => store.remove());
    },
  };
}
