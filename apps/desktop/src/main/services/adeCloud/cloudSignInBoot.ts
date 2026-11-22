/**
 * On a cloud machine made by an older ADE, before the brain serves: turn the
 * sign-ins the machine was made with (instance env) into what each provider
 * reads. ADE no longer puts sign-ins in a new machine's env (the account
 * vault carries them), so on a new machine this finds no key and does
 * nothing; an older machine keeps its env until it is deleted. Every provider but Codex reads its key from the env
 * as it is. Codex's app server, which ADE chats run on, ignores
 * `OPENAI_API_KEY` (measured with codex 0.164 on a box: "Missing bearer"),
 * and reads only its auth file, so the key is written there in the shape
 * `codex login --with-api-key` writes.
 *
 * Only on a cloud machine (`ADE_HOST_INSTANCE_ID` is `cloud:<id>`, set
 * by its template), so an `OPENAI_API_KEY` in someone's own shell never
 * changes their Codex sign-in. A Codex sign-in already on the machine always
 * wins: the file is written only when there is none. Nothing is logged but a
 * fixed reason.
 */

import fs from "node:fs";
import path from "node:path";
import { codexConfigHome } from "../shared/providerConfigHomes";

type Logger = { warn?(event: string, meta?: Record<string, unknown>): void } | null | undefined;

export type CloudSignInBootResult = "not_cloud" | "no_key" | "kept_existing" | "wrote_codex_auth" | "failed";

export function applyCloudSignIns(args: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  logger?: Logger;
} = {}): CloudSignInBootResult {
  const env = args.env ?? process.env;
  if (!env.ADE_HOST_INSTANCE_ID?.trim().startsWith("cloud:")) return "not_cloud";
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) return "no_key";
  const home = codexConfigHome({ env, ...(args.homeDir ? { homeDir: args.homeDir } : {}) });
  const authPath = path.join(home, "auth.json");
  const draftPath = path.join(home, `.auth.json.ade-${process.pid}`);
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // Whole before it has its name: a write cut short (a full disk) leaves no
    // half file that the next start would keep as someone's sign-in.
    fs.writeFileSync(draftPath, `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }, null, 2)}\n`, { mode: 0o600 });
    // A link never replaces a file: a sign-in made on the machine, even one
    // written meanwhile, is kept. Only this step's EEXIST means that.
    try {
      fs.linkSync(draftPath, authPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") return "kept_existing";
      throw error;
    }
    return "wrote_codex_auth";
  } catch (error) {
    args.logger?.warn?.("cloud.codex_auth_write_failed", { code: (error as NodeJS.ErrnoException | null)?.code ?? "unknown" });
    return "failed";
  } finally {
    // An optional step: a draft it can't remove must never stop the brain.
    try {
      fs.rmSync(draftPath, { force: true });
    } catch (error) {
      args.logger?.warn?.("cloud.codex_auth_draft_remove_failed", { code: (error as NodeJS.ErrnoException | null)?.code ?? "unknown" });
    }
  }
}
