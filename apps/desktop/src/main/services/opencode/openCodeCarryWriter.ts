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
 * - `credential.create` with an id that exists answers 409, so a new copy of
 *   the same row is a remove, then a create.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OpenCodeClient } from "@opencode/client";
import type { Logger } from "../logging/logger";
import { resolveAdeOpenCodeRuntimeRoot } from "../../../shared/opencodeDataHome";
import type { OpenCodeCredentialWriter } from "../providerLogins/providerLoginApply";
import { forgetRouteSecretsForSource } from "../chat/harnessPresetConfigHomes";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import { SHARED_OPENCODE_PROFILE } from "./openCodeConfig";
import { bumpOpenCodeCredentialsGeneration, readOpenCodeCredentials, resolveAdeOpenCodeDbPath } from "./openCodeCredentials";
import { clearOpenCodeInventoryCache } from "./openCodeInventory";
import { acquireOpenCodeServer } from "./openCodeServer";

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

/** The opencode.ai login changed in the store: drop every copy of "who pays" and every route's copied token. */
function openCodeLoginChanged(): void {
  bumpOpenCodeCredentialsGeneration();
  clearOpenCodeInventoryCache();
  for (const sourceKey of ["opencode", "opencode-go"]) forgetRouteSecretsForSource(sourceKey);
}

/** The row is in the store now (read with SQL, read-only; no server needed). */
function hasCredential(dbPath: string, id: string): boolean {
  return readOpenCodeCredentials(dbPath).some((credential) => credential.id === id);
}

/** The shared server writes ADE's own store only: a write meant for another store is refused, never sent there. */
function assertAdeStore(dbPath: string): void {
  if (path.resolve(dbPath) !== path.resolve(resolveAdeOpenCodeDbPath())) {
    throw Object.assign(new Error("The sign-in names another OpenCode store than ADE's."), { code: "ESTORE" });
  }
}

export function createOpenCodeCarryWriter(logger: Logger | null): OpenCodeCredentialWriter {
  return {
    async put(dbPath, row) {
      assertAdeStore(dbPath);
      const done = await withSharedClient(logger, async (client) => {
        if (hasCredential(dbPath, row.id)) await client.credential.remove({ credentialID: row.id });
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
      openCodeLoginChanged();
      return "ok";
    },
    async remove(dbPath, id) {
      assertAdeStore(dbPath);
      if (!hasCredential(dbPath, id)) return "ok";
      const done = await withSharedClient(logger, async (client) => {
        await client.credential.remove({ credentialID: id });
        return true;
      });
      if (!done) return "not_installed";
      openCodeLoginChanged();
      return "ok";
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
    if (answered) openCodeLoginChanged();
    return Boolean(answered);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * How long before expiry the owner asks OpenCode to renew: inside OpenCode's
 * 5-minute window, with 30 s for the timer and the call.
 */
export const OPENCODE_RENEW_AHEAD_MS = 270_000;
