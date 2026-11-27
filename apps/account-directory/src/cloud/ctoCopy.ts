import { accountRepoScopeKey } from "../../../desktop/src/shared/accountSettingsScope";
import { CTO_ACCOUNT_COPY_VAULT_KEY, CTO_ACCOUNT_COPY_VAULT_KIND } from "../../../desktop/src/shared/ctoAccountCopy";
import { CLOUD_CTO_TAIL_MAX_CHARS, type CloudCtoCopy, type CloudCtoCopySummary } from "./contract";
import { readVaultItem, readVaultScope, relayFetch, type RelayEnv, type VaultRecord } from "./accountVault";
import { fail, json } from "./http";
import { logCloud } from "./store";

/**
 * The CTO's account copy for a client with no computer
 * (`GET /cloud/cto?origin=`): its identity, notes, open work, routines and
 * the newest part of its last turns. The copy is the vault item its home
 * machine writes after each CTO turn (scope `repo:<origin>`, kind `cto_copy`,
 * key `cto`, `gz1:` + base64 gzip of JSON; the desktop's
 * `ctoAccountCopyService.ts`). Read with the caller's own bearer; opened in
 * memory only, never stored or logged.
 */

const ENCODED_PREFIX = "gz1:";
/** Each notes file as shown; the copy keeps them whole for a new home. */
const NOTES_MAX_CHARS = 20_000;
/** A decoded copy past this is not one the home machine wrote. */
const MAX_DECODED_BYTES = 1_000_000;
const LEGACY_PAGES = 4;

async function gunzipText(base64: string): Promise<string | null> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return null;
  }
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DECODED_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);

/** The copy as a client shows it, or null when the value is not a copy this ADE can read. */
export async function decodeCtoCopy(raw: string | null): Promise<CloudCtoCopy | null> {
  if (!raw || !raw.startsWith(ENCODED_PREFIX)) return null;
  const decoded = await gunzipText(raw.slice(ENCODED_PREFIX.length));
  if (!decoded) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.v !== 1) return null;
  const tail = text(parsed.tail);
  const story = parsed.story && typeof parsed.story === "object" ? parsed.story as Record<string, unknown> : null;
  const routines = Array.isArray(parsed.routines) ? parsed.routines : [];
  return {
    ownerName: text(parsed.ownerName).trim() || "another computer",
    savedAt: text(parsed.savedAt) || null,
    identity: parsed.identity && typeof parsed.identity === "object" && !Array.isArray(parsed.identity) ? parsed.identity as Record<string, unknown> : {},
    projectNotes: clip(text(parsed.projectNotes), NOTES_MAX_CHARS),
    userNotes: clip(text(parsed.userNotes), NOTES_MAX_CHARS),
    openWork: typeof parsed.openWork === "string" ? clip(parsed.openWork, NOTES_MAX_CHARS) : null,
    rules: clip(text(parsed.rules), NOTES_MAX_CHARS),
    skills: (Array.isArray(parsed.skills) ? parsed.skills : []).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const skill = entry as Record<string, unknown>;
      const name = text(skill.name).trim();
      if (!name) return [];
      const description = /^---\r?\n[\s\S]*?^description:\s*(.*)$/m.exec(text(skill.text))?.[1]?.trim() ?? "";
      return [{ name, description: clip(description, 240) }];
    }).slice(0, 50),
    routines: routines.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const routine = entry as Record<string, unknown>;
      if (typeof routine.cron !== "string" || !routine.cron.trim()) return [];
      return [{
        title: text(routine.title),
        cron: routine.cron,
        ...(typeof routine.timeZone === "string" ? { timeZone: routine.timeZone } : {}),
        ...(typeof routine.check === "string" && routine.check.trim() ? { check: clip(routine.check, 1_000) } : {}),
        paused: routine.paused === true,
      }];
    }).slice(0, 50),
    // The newest turns are at the end; the start is cut.
    tail: tail.length > CLOUD_CTO_TAIL_MAX_CHARS ? tail.slice(tail.length - CLOUD_CTO_TAIL_MAX_CHARS) : tail,
    tailTruncated: tail.length > CLOUD_CTO_TAIL_MAX_CHARS,
    story: story && typeof story.summary === "string" && story.summary.trim()
      ? { summary: clip(story.summary, NOTES_MAX_CHARS), coveredThrough: text(story.coveredThrough) || null }
      : null,
  };
}

export async function routeCtoCopy(request: Request, url: URL, env: RelayEnv): Promise<Response> {
  if (request.method !== "GET") return fail("not_found", "Daex Cloud has no such route.", 404);
  const authorization = request.headers.get("authorization");
  if (!authorization) return fail("unauthorized", "Sign in to Daex to use Daex Cloud.", 401);
  if (!relayFetch(env)) return fail("unavailable", "Daex can't reach your CTO's copy right now. Try again soon.", 503);
  const scope = accountRepoScopeKey(url.searchParams.get("origin"));
  if (!scope) return fail("bad_request", "That isn't a repository Daex can name.", 400);

  const ref = { scope, kind: CTO_ACCOUNT_COPY_VAULT_KIND, key: CTO_ACCOUNT_COPY_VAULT_KEY };
  let stored: VaultRecord | null;
  const read = await readVaultItem(env, authorization, ref);
  if (read.ok) {
    stored = read.value;
  } else if (read.reason === "no_route") {
    const rows = await readVaultScope(env, authorization, scope, LEGACY_PAGES, { partial: true });
    if (!rows) return fail("unavailable", "Daex can't reach your CTO's copy right now. Try again soon.", 503);
    stored = rows.find((row) => row.kind === ref.kind && row.key === ref.key && !row.deleted) ?? null;
  } else {
    return fail("unavailable", "Daex can't reach your CTO's copy right now. Try again soon.", 503);
  }
  if (!stored) return json({ available: false, copy: null } satisfies CloudCtoCopySummary);
  const copy = await decodeCtoCopy(stored.value);
  if (!copy) {
    logCloud("cloud.cto_copy_unreadable", {});
    return json({ available: false, copy: null } satisfies CloudCtoCopySummary);
  }
  return json({ available: true, copy } satisfies CloudCtoCopySummary);
}
