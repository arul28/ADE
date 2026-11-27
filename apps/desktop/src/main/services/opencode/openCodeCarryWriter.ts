/**
 * The OpenCode half of the sign-in carry (P5), run by the brain:
 *
 * - `createOpenCodeCarryWriter`: apply writes the carried opencode.ai row
 *   into ADE's own OpenCode store through OpenCode's `credential` API on the
 *   shared server. OpenCode makes and migrates its store and checks the
 *   value, and a running server has the row at once; no SQL is written.
 * - `renewOpenCodeLogin`: the owner computer's renewal ahead of expiry.
 *
 * What OpenCode 2.0.29 does, checked against the pinned binary on 2026-11-17
 * with a local stand-in for opencode.ai (never a real account):
 * - It renews an opencode.ai login only when it resolves it with 5 minutes or
 *   less left (280 s renewed, 320 s did not). The renewal posts the refresh
 *   token to `<server>/auth/device/token` and stores the refresh token the
 *   answer carries, so a rotated token replaces the old one. Treat the family
 *   as rotating: two holders of one refresh token would sign each other out.
 * - A running server resolves the login when it first loads a location. So
 *   `integration.list` for a new, empty folder renews it with no model
 *   request; the same call for a folder it already loaded does not.
 * - With an empty refresh token (an access-only copy) the renewal is refused
 *   and the row stays as it is: the copy works until its own expiry.
 * - `credential.create` with an id that exists answers 409. Each copy is a
 *   new row instead: created and made the one in use first, then the copy
 *   before is removed, so a failed write never leaves no sign-in.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OpenCodeClient } from "@opencode/client";
import type { Logger } from "../logging/logger";
import { resolveAdeOpenCodeRuntimeRoot } from "../../../shared/opencodeDataHome";
import type { OpenCodeCredentialWriter } from "../providerLogins/providerLoginApply";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import { SHARED_OPENCODE_PROFILE } from "./openCodeConfig";
import { loadNodeSqlite } from "../projects/readOnlySqlite";
import { credentialsChanged } from "./openCodeAccounts";
import { readOpenCodeCredentialValue, resolveAdeOpenCodeDbPath } from "./openCodeCredentials";
import { acquireOpenCodeServer } from "./openCodeServer";
import { BRAND } from "../../../shared/brand";

const CARRY_OWNER_ID = "provider-login-carry";

/**
 * Run `fn` on the shared server, started when none runs. Null when ADE's
 * OpenCode is not on this computer: the carry never downloads OpenCode only
 * to write a sign-in. The next pass tries again.
 */
async function withSharedClient<T>(logger: Logger | null, fn: (client: OpenCodeClient) => Promise<T>): Promise<T | null> {
  if (!resolveOpenCodeBinaryPath()) return null;
  const lease = await acquireOpenCodeServer({
    profile: SHARED_OPENCODE_PROFILE,
    ownerKind: "auth",
    ownerId: CARRY_OWNER_ID,
    logger,
  });
  try {
    return await fn(lease.client);
  } finally {
    lease.release();
  }
}

/**
 * The row is in the store now (read with SQL, read-only; no server needed).
 * A store that cannot be read now throws EBUSY: the applied entry then stays
 * and the next pass tries the removal again, never treating it as gone.
 */
function hasCredential(dbPath: string, id: string): boolean {
  const value = readOpenCodeCredentialValue(dbPath, id);
  if (value === "unreadable") throw Object.assign(new Error("OpenCode's store is busy."), { code: "EBUSY" });
  return value !== null;
}

/** One row out by SQL, for a store with no OpenCode to ask. Nothing else is ever written by SQL. */
function deleteCredentialRow(dbPath: string, id: string): void {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare("DELETE FROM credential WHERE id = ?").run(id);
  } finally {
    db.close();
  }
}

/** The shared server writes ADE's own store only: a write meant for another store is refused, never sent there. */
function assertAdeStore(dbPath: string): void {
  if (path.resolve(dbPath) !== path.resolve(resolveAdeOpenCodeDbPath())) {
    throw Object.assign(new Error(`The sign-in names another OpenCode store than ${BRAND.NAME}'s.`), { code: "ESTORE" });
  }
}

export function createOpenCodeCarryWriter(logger: Logger | null): OpenCodeCredentialWriter {
  return {
    async put(dbPath, row) {
      assertAdeStore(dbPath);
      const done = await withSharedClient(logger, async (client) => {
        await client.credential.create({
          id: row.id,
          integrationID: "opencode",
          label: row.label,
          value: row.value as Parameters<OpenCodeClient["credential"]["create"]>[0]["value"],
          activate: true,
        });
        return true;
      });
      if (!done) return "not_installed";
      credentialsChanged("opencode");
      return "ok";
    },
    async remove(dbPath, id) {
      assertAdeStore(dbPath);
      if (!hasCredential(dbPath, id)) return;
      const done = await withSharedClient(logger, async (client) => {
        await client.credential.remove({ credentialID: id });
        return true;
      });
      // No OpenCode here (it was removed): the row still goes, so an ADE sign-out never leaves an account's sign-in.
      if (!done) deleteCredentialRow(dbPath, id);
      credentialsChanged("opencode");
    },
  };
}

/**
 * Make ADE's OpenCode renew its opencode.ai login now. It renews only inside
 * the last 5 minutes, so the planner aims this at `OPENCODE_RENEW_AHEAD_MS`
 * before expiry. A new, empty folder makes the shared server load a location,
 * which resolves the login (see the top). True when OpenCode answered; the
 * sync then reads the store again and pushes the renewed row.
 */
export async function renewOpenCodeLogin(logger: Logger | null): Promise<boolean> {
  const root = resolveAdeOpenCodeRuntimeRoot();
  let folder: string | null = null;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    folder = fs.mkdtempSync(path.join(root, "renew-"));
  } catch {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-renew-"));
  }
  try {
    const answered = await withSharedClient(logger, async (client) => {
      await client.integration.list({ location: { directory: folder! } });
      return true;
    });
    if (answered) credentialsChanged("opencode");
    return Boolean(answered);
  } finally {
    try {
      // The server may still watch the folder (Windows refuses to remove it then); a leftover empty folder is harmless.
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      logger?.warn("opencode.carry_renew_folder_left", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
  }
}

/**
 * How long before expiry the owner asks OpenCode to renew: inside OpenCode's
 * 5-minute window, with 30 s for the timer and the call.
 */
export const OPENCODE_RENEW_AHEAD_MS = 270_000;
