import {
  handleDeviceAuthorizationRequest,
  type DeviceAuthorizationRequestOptions,
} from "./deviceAuthorization";
import { authenticate, type CallerTokenEnv } from "./callerToken";
import {
  callActivityRelay,
  type ActivityRelayEnv,
  type ActivityRelayOptions,
} from "./activityRelay";
import {
  createPairingProofBroker,
  mintPairingGrant,
  type PairingProofBroker,
} from "./pairingGrants";
import { logDirectoryLifecycle, logDirectoryRefusal } from "./logging";

export type { ActivityRelayOptions } from "./activityRelay";
/**
 * Re-exported, not just moved: the CLI's auto-recovery mirrors this value and
 * points at this module for it (`machinePairingAutoRecovery.ts`), so the name
 * stays part of the directory's published surface even though the freshness
 * check itself now lives with the rest of the token verification.
 */
export { PAIRING_AUTH_FRESHNESS_MS } from "./callerToken";

export type Env = CallerTokenEnv & ActivityRelayEnv & {
  DB: D1Database;
  WEB_CLIENT_ORIGIN?: string;
  ONLINE_WINDOW_MS?: string;
};

export type DirectoryRequestOptions = DeviceAuthorizationRequestOptions & {
  activityRelay?: ActivityRelayOptions;
};

type MachineRow = {
  user_id: string;
  machine_key: string;
  device_id: string | null;
  name: string | null;
  custom_name: string | null;
  platform: string | null;
  device_type: string | null;
  pubkey: string | null;
  reachable_endpoints: string | null;
  last_seen_at: number | null;
  created_at: number | null;
};

/**
 * Every column `machineRecord` reads, in one place.
 *
 * Four routes select the same machine row and all four must stay in step with
 * `MachineRow`: a column added to one select and forgotten in another surfaces
 * as a field that is present on the register response and missing from the
 * list.
 */
const MACHINE_ROW_COLUMNS = `user_id, machine_key, device_id, name, custom_name, platform, device_type,
           pubkey, reachable_endpoints, last_seen_at, created_at`;

type ReachableEndpoint = {
  kind: "lan" | "tailnet" | "relay";
  url?: string;
  host?: string;
  port?: number;
};

type RegisterInput = {
  machineKey: string;
  deviceId: string;
  /**
   * A per-account hash of an OS-level machine identifier, when the client can
   * read one. Null on older clients, on hosts with no such identifier, and on
   * any registration made without an account id to salt with.
   *
   * It exists because `deviceId` does NOT survive a `~/.ade` wipe — it lives in
   * the same secrets directory as the machine key — so a reinstall produces two
   * fresh identifiers and dedup has nothing to match. This one is derived from
   * the hardware and the OS install, so it is the same after the wipe.
   *
   * Caller-supplied and therefore forgeable, exactly like `deviceId`: on a
   * plain token it authorizes nothing. See `supersedePhantomDuplicates` for the
   * proof bar that makes acting on it safe.
   */
  hardwareId: string | null;
  name: string;
  platform: string;
  deviceType: string;
  pubkey: string | null;
  reachableEndpoints: ReachableEndpoint[];
  retainRelayEndpoints: boolean;
  /**
   * Set only for a deliberate, user-initiated link — never on the periodic
   * heartbeat. It separates "this machine is alive" from "the user is adding
   * this machine back".
   *
   * On its own it is an unauthenticated client boolean and clears nothing: it
   * only lifts a revocation when the caller's token ALSO proves an interactive
   * sign-in within `PAIRING_AUTH_FRESHNESS_MS`.
   */
  pairing: boolean;
  /**
   * Optional second proof for `pairing`, minted by this worker at the end of a
   * `/device/*` sign-in and bound to that user and machine key. Accepted in
   * place of claim freshness so re-pairing cannot be bricked by a token shape
   * that carries no authentication-time claim. Absent on every heartbeat.
   */
  pairingGrant: string | null;
};

type MachineRevocationRow = {
  machine_key: string;
  device_id: string | null;
  revoked_at: number;
};

type MachineRecord = {
  machineKey: string;
  deviceId: string | null;
  name: string | null;
  customName: string | null;
  platform: string | null;
  deviceType: string | null;
  pubkey: string | null;
  reachableEndpoints: ReachableEndpoint[];
  lastSeenAt: number | null;
  createdAt: number | null;
};

type AccountRoute =
  | { kind: "register" }
  | { kind: "list" }
  | { kind: "machine"; machineKey: string };

export const DEFAULT_ONLINE_WINDOW_MS = 90_000;
/**
 * Most rows one register call may supersede.
 *
 * A device with more phantom keys than this is either pathological or hostile,
 * and either way there is no reason to let a single request delete an unbounded
 * slice of the account's roster. The rest are cleaned up by the next proven
 * re-pair, oldest first.
 */
export const MAX_SUPERSEDED_MACHINES = 5;
const MAX_PUBKEY_CHARS = 128;
const MAX_MACHINE_KEY_CHARS = 128;
/**
 * A hardware anchor is a sha256 hex digest (64 chars); the cap is slack, not a
 * shape check. Validating the shape would buy nothing — the value is
 * caller-supplied either way, and what makes it safe to act on is the pairing
 * proof, not its formatting.
 */
const MAX_HARDWARE_ID_CHARS = 128;
/** A grant is 32 random bytes in base64url (43 chars); the cap is slack, not a shape check. */
const MAX_PAIRING_GRANT_CHARS = 256;
const MAX_CUSTOM_NAME_CHARS = 80;
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function withServerTiming(
  response: Response,
  authDurationMs: number,
  dbDurationMs: number,
): Response {
  const duration = (value: number) => Math.max(0, value).toFixed(2);
  const headers = new Headers(response.headers);
  headers.set(
    "server-timing",
    `auth;dur=${duration(authDurationMs)}, db;dur=${duration(dbDurationMs)}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalString(source: Record<string, unknown>, key: string): string | null | undefined {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseReachableEndpoints(value: unknown): ReachableEndpoint[] | null {
  if (!Array.isArray(value)) return null;
  const endpoints: ReachableEndpoint[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const kind = candidate.kind;
    if (kind !== "lan" && kind !== "tailnet" && kind !== "relay") return null;

    const url = candidate.url === undefined ? undefined : requiredString(candidate, "url") ?? null;
    const host = candidate.host === undefined ? undefined : requiredString(candidate, "host") ?? null;
    if (url === null || host === null || (!url && !host)) return null;

    const rawPort = candidate.port;
    const port = rawPort === undefined
      ? undefined
      : typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535
        ? rawPort
        : null;
    if (port === null) return null;

    endpoints.push({
      kind,
      ...(url ? { url } : {}),
      ...(host ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
    });
  }
  return endpoints;
}

function parseRegisterInput(value: unknown): RegisterInput | null {
  if (!isRecord(value)) return null;
  const machineKey = requiredString(value, "machineKey");
  const deviceId = requiredString(value, "deviceId");
  const hardwareId = optionalString(value, "hardwareId");
  const name = requiredString(value, "name");
  const platform = requiredString(value, "platform");
  const deviceType = requiredString(value, "deviceType");
  const pubkey = optionalString(value, "pubkey");
  const reachableEndpoints = parseReachableEndpoints(value.reachableEndpoints);
  const retainRelayEndpoints = value.retainRelayEndpoints ?? false;
  const pairing = value.pairing ?? false;
  const pairingGrant = optionalString(value, "pairingGrant");
  if (
    !machineKey
    || machineKey.length > MAX_MACHINE_KEY_CHARS
    || !deviceId
    || hardwareId === undefined
    || (hardwareId !== null && hardwareId.length > MAX_HARDWARE_ID_CHARS)
    || !name
    || !platform
    || !deviceType
    || pubkey === undefined
    || (pubkey !== null && pubkey.length > MAX_PUBKEY_CHARS)
    || !reachableEndpoints
    || typeof retainRelayEndpoints !== "boolean"
    || typeof pairing !== "boolean"
    || pairingGrant === undefined
    || (pairingGrant !== null && pairingGrant.length > MAX_PAIRING_GRANT_CHARS)
  ) {
    return null;
  }
  return {
    machineKey,
    deviceId,
    hardwareId,
    name,
    platform,
    deviceType,
    pubkey,
    reachableEndpoints,
    retainRelayEndpoints,
    pairing,
    pairingGrant,
  };
}

function routeAccount(pathname: string): AccountRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "account" || parts[1] !== "machines") return null;
  if (parts.length === 2) return { kind: "list" };
  if (parts.length === 3 && parts[2] === "register") return { kind: "register" };
  if (parts.length !== 3) return null;
  try {
    const machineKey = decodeURIComponent(parts[2] ?? "").trim();
    return machineKey ? { kind: "machine", machineKey } : null;
  } catch {
    return null;
  }
}

function parseStoredEndpoints(value: string | null): ReachableEndpoint[] {
  if (!value) return [];
  try {
    return parseReachableEndpoints(JSON.parse(value)) ?? [];
  } catch {
    return [];
  }
}

function machineRecord(row: MachineRow): MachineRecord {
  return {
    machineKey: row.machine_key,
    deviceId: row.device_id,
    name: row.name,
    customName: row.custom_name,
    platform: row.platform,
    deviceType: row.device_type,
    pubkey: row.pubkey,
    reachableEndpoints: parseStoredEndpoints(row.reachable_endpoints),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function onlineWindowMs(env: Env): number {
  const configured = Number(env.ONLINE_WINDOW_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.trunc(configured)
    : DEFAULT_ONLINE_WINDOW_MS;
}

type RefusalLogger = (
  event: "directory.register_refused" | "directory.supersede_refused",
  code: string,
  reason?: string,
) => void;

/**
 * Other machine rows this account already has for the SAME physical device.
 *
 * This is the phantom-duplicate query. A reinstall (or any client-side identity
 * rotation) mints a fresh machine key, and rows are keyed `(user_id,
 * machine_key)`, so the old row survives forever as a machine the user never
 * owned twice. Ordered oldest-seen first so that when the cap bites, it is the
 * stalest rows that go — and so the newest surviving `custom_name` is the last
 * one the caller sees.
 *
 * TWO identifiers can name the same device, and the union is the point. The
 * device id catches an in-place reinstall, where `~/.ade/secrets` survived. The
 * hardware anchor catches the case that motivated it — a full `~/.ade` wipe,
 * where the device id was minted fresh alongside the machine key and matches
 * nothing. Either one alone leaves a phantom row behind in the other's case.
 *
 * Null-anchor rows can only ever be matched by device id. That is expected: a
 * row written before this shipped, or by a host that cannot read an identifier,
 * is folded in the first time the same physical machine re-registers with fresh
 * auth AND a surviving device id, and otherwise ages out by hand from the
 * machine list. Nothing here back-fills an anchor onto a row it did not send.
 *
 * One statement rather than two, so `order by`/`limit` apply to the UNION: two
 * capped queries merged in the worker could return six rows, or drop the oldest
 * of one set in favour of a newer row from the other.
 */
async function duplicateMachinesForDevice(
  env: Env,
  args: { userId: string; deviceId: string | null; hardwareId: string | null; machineKey: string },
): Promise<Array<{ machine_key: string; custom_name: string | null }>> {
  return (await env.DB.prepare(`
    select machine_key, custom_name
      from machines
     where user_id = ?
       and machine_key <> ?
       and (device_id = ? or hardware_id = ?)
     order by last_seen_at asc
     limit ?
  `).bind(
    args.userId,
    args.machineKey,
    args.deviceId,
    args.hardwareId,
    MAX_SUPERSEDED_MACHINES,
  ).all<{ machine_key: string; custom_name: string | null }>()).results ?? [];
}

async function machineRevocation(
  env: Env,
  userId: string,
  machineKey: string,
): Promise<MachineRevocationRow | null> {
  return await env.DB.prepare(`
    select machine_key, device_id, revoked_at
      from revoked_machines
     where user_id = ? and machine_key = ?
  `).bind(userId, machineKey).first<MachineRevocationRow>();
}

/**
 * Step one of a register call: may this machine be on this account at all?
 *
 * Removal is only durable if the removed machine cannot re-register itself. Its
 * heartbeat carries a valid account token for as long as it stays signed in, so
 * the revocation — not the token — is what decides. Returns the response to
 * send when the answer is no, and `null` when registration may proceed.
 */
async function enforceRevocationGate(
  request: Request,
  env: Env,
  args: {
    userId: string;
    input: RegisterInput;
    correlationId: string;
    relayOptions: ActivityRelayOptions;
    pairingProof: PairingProofBroker;
    refuse: RefusalLogger;
  },
): Promise<Response | null> {
  const { userId, input, refuse } = args;
  const revocation = await machineRevocation(env, userId, input.machineKey);
  if (!revocation) return null;

  // `pairing` is honored ONLY together with proof of a freshly completed
  // interactive sign-in (either proof below). Everything else in this request
  // — including `deviceId`, which used to carry a "reinstalled machine"
  // recovery clause — is supplied by the caller, so it can be forged by
  // exactly the removed machine this gate exists to stop. A genuine reinstall
  // recovers the same way every other re-pair does: the user signs in and ADE
  // re-pairs immediately after.
  if (!input.pairing) {
    refuse("directory.register_refused", "machine_revoked");
    return json({
      error: "machine removed from account",
      code: "machine_revoked",
      revokedAt: revocation.revoked_at,
    }, { status: 403 });
  }
  // Two independent proofs, either of which is sufficient, neither of which a
  // removed machine can produce from the token it is still holding.
  //
  // The claim is the fast path and is checked first so a genuinely fresh
  // sign-in never spends a grant it does not need. The grant is the fallback,
  // and it exists because the claim path fails CLOSED: ADE's brain
  // authenticates with a Clerk OAuth access token, and `auth_time`/`fva` are
  // not in the documented default claim set for that token shape. If they are
  // absent in production, claim-only freshness would make every removal
  // permanent — the original Blocker wearing a different hat.
  const proof = await args.pairingProof.prove();
  if (proof.kind === "none") {
    refuse(
      "directory.register_refused",
      "pairing_authentication_required",
      // Support's first question is always which of the two it was: a machine
      // that never presented a grant is a client-side problem, a rejected one
      // is expired, replayed, or minted for another machine.
      input.pairingGrant ? "grant_rejected" : "no_proof",
    );
    return json({
      error: "Sign in again on this computer to reconnect it to your ADE account",
      code: "pairing_authentication_required",
      revokedAt: revocation.revoked_at,
    }, { status: 403 });
  }
  // A grant is RESERVED above, not destroyed, and the reservation is what makes
  // the next few lines recoverable. Reserving is one atomic statement, so
  // single-use is enforced exactly as strictly as the old delete enforced it —
  // two concurrent registrations still cannot both hold it — but a relay outage
  // no longer burns the user's only credential. On failure it goes back with its
  // ORIGINAL expiry, so forcing relay failures buys nothing: the grant still
  // dies at the moment it was always going to die.
  //
  // Clear the relay's revocation first: a machine back on the roster but unable
  // to publish is a worse state than one that retries the re-pair.
  const restored = await callActivityRelay(request, env, {
    operation: "restore",
    machineKey: input.machineKey,
    correlationId: args.correlationId,
    options: args.relayOptions,
  });
  if (!restored.ok) {
    // Nothing is proven any more: the credential is back in circulation.
    await args.pairingProof.release();
    refuse("directory.register_refused", "activity_relay_unavailable", restored.reason);
    return json({
      error: "activity relay unavailable",
      code: "activity_relay_unavailable",
      detail: restored.reason,
    }, { status: 503 });
  }
  // Still proof for anything later in this request, never spendable again.
  await args.pairingProof.consume();
  await env.DB
    .prepare("delete from revoked_machines where user_id = ? and machine_key = ?")
    .bind(userId, input.machineKey)
    .run();
  return null;
}

/** Step two: write the row. The only unconditional write a heartbeat makes. */
async function upsertMachine(
  env: Env,
  args: { userId: string; input: RegisterInput; nowMs: number },
): Promise<void> {
  const { input } = args;
  await env.DB.prepare(`
    insert into machines (
      user_id, machine_key, device_id, name, platform, device_type, pubkey,
      reachable_endpoints, last_seen_at, created_at, hardware_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(user_id, machine_key) do update set
      device_id = excluded.device_id,
      -- coalesce, and not excluded.hardware_id: an anchor is optional on every
      -- request, so a single heartbeat from a host that momentarily could not
      -- read one -- a sandbox, a slow probe, a downgrade -- must not erase the
      -- anchor this row already learned. A new non-null value still wins.
      hardware_id = coalesce(excluded.hardware_id, machines.hardware_id),
      name = excluded.name,
      platform = excluded.platform,
      device_type = excluded.device_type,
      pubkey = excluded.pubkey,
      reachable_endpoints = case
        when ? = 1
          and json_valid(machines.reachable_endpoints)
          and exists (
            select 1
              from json_each(machines.reachable_endpoints)
             where json_extract(value, '$.kind') = 'relay'
          )
          and not exists (
            select 1
              from json_each(excluded.reachable_endpoints)
             where json_extract(value, '$.kind') = 'relay'
          )
        then (
          select json_group_array(json(endpoint))
            from (
              select value as endpoint
                from json_each(excluded.reachable_endpoints)
              union all
              select value as endpoint
                from json_each(machines.reachable_endpoints)
               where json_extract(value, '$.kind') = 'relay'
            )
        )
        else excluded.reachable_endpoints
      end,
      last_seen_at = excluded.last_seen_at
  `).bind(
    args.userId,
    input.machineKey,
    input.deviceId,
    input.name,
    input.platform,
    input.deviceType,
    input.pubkey,
    JSON.stringify(input.reachableEndpoints),
    args.nowMs,
    args.nowMs,
    input.hardwareId,
    input.retainRelayEndpoints ? 1 : 0,
  ).run();
}

/**
 * Step three: phantom duplicates — the OTHER half of the reinstall story.
 *
 * Machines are keyed `(user_id, machine_key)`, so a client that rotates its
 * identity file — a reinstall, a wiped config, a restored backup — lands as a
 * second row for the same physical computer. The user sees a duplicate,
 * removes the one that looks stale, and if they guess wrong they have just
 * revoked the live install. Nothing about that is recoverable by the user, so
 * the directory folds the old rows into the new one instead of letting them
 * accumulate.
 *
 * FOLDS, not just deletes: the one thing a superseded row holds that the new
 * one cannot rebuild is the name the user typed. Losing "Studio Mac" because a
 * reinstall rotated a key is a small betrayal of a deliberate act, so the most
 * recently seen superseded name is carried onto the survivor — and only when
 * the survivor has none of its own, because a name set on the new row is the
 * fresher statement of intent.
 *
 * The gate is the SAME proof that lifts a revocation, for the same reason:
 * `deviceId` is caller-supplied and forgeable, so on a plain token it
 * authorizes nothing — otherwise any machine could claim another's device id
 * and delete that machine's row. With a proven-fresh human behind the call it
 * is exactly the signal we want. `hardwareId` is caller-supplied in exactly
 * the same way and gets exactly the same treatment: it is a better identifier
 * (it survives the `~/.ade` wipe that invalidates the device id), not a more
 * trustworthy one, and nothing about it is attested. The fresh-auth bar is
 * the whole of what makes acting on either of them safe.
 *
 * Superseded keys get NO revocation row. The physical device holds the new
 * key; blocking the old one would trapdoor any client that rolls its identity
 * file back (a restored snapshot, a failed migration) into a permanent
 * refusal. An absent key simply registers again. For the same reason the
 * relay is not called: the device did not leave the account, so its Activity
 * is still the user's own.
 */
async function supersedePhantomDuplicates(
  env: Env,
  args: {
    userId: string;
    input: RegisterInput;
    pairingProof: PairingProofBroker;
    refuse: RefusalLogger;
  },
): Promise<string[]> {
  const { userId, input } = args;
  // Empty identifiers are normalized to null before they reach the query, and
  // that is load-bearing: `device_id = ''` would match every row a future
  // relaxation of the parser let through with an unset device id, while
  // `device_id = null` matches nothing at all. `hardwareId` is already null
  // whenever the client sent none.
  const matchDeviceId = input.deviceId || null;
  const matchHardwareId = input.hardwareId || null;
  if (!matchDeviceId && !matchHardwareId) return [];

  const duplicates = await duplicateMachinesForDevice(env, {
    userId,
    deviceId: matchDeviceId,
    hardwareId: matchHardwareId,
    machineKey: input.machineKey,
  });
  if (duplicates.length === 0) return [];

  const proof = await args.pairingProof.prove();
  if (proof.kind === "none") {
    // Not a refused REGISTRATION — the machine is registered, the duplicate
    // simply stays. Logged because "why is my Mac listed twice" is the support
    // question this whole path exists to answer.
    args.refuse(
      "directory.supersede_refused",
      "supersede_authentication_required",
      `duplicates=${duplicates.length}`,
    );
    return [];
  }
  // Spend before deleting, not after: a consume that failed once the rows were
  // already gone would leave the grant reservable again in a minute, and a
  // credential that can be spent twice is the worse of the two failures. Both
  // are D1 writes on one database, so the window is a hypothetical either way.
  await args.pairingProof.consume();

  // Rows arrive oldest-seen first, so the last non-null name is the one the
  // user set most recently.
  const carriedName = duplicates.reduce<string | null>(
    (carried, row) => row.custom_name ?? carried,
    null,
  );
  // ONE batch, not a loop of independent writes. The grant is already spent by
  // the time these run, so a D1 failure partway through a sequential loop would
  // leave half the phantoms deleted with no credential left to finish the job.
  await env.DB.batch([
    // `custom_name is null` is the whole carry-forward rule, in the statement
    // rather than in a read-then-write: a name the user set on the surviving
    // row must win over an inherited one, and nothing may clobber it.
    ...(carriedName
      ? [
        env.DB.prepare(`
          update machines
             set custom_name = ?
           where user_id = ? and machine_key = ? and custom_name is null
        `).bind(carriedName, userId, input.machineKey),
      ]
      : []),
    // The identifiers stay in the predicate, and it mirrors the select exactly:
    // the row was chosen a moment ago because it matched one of them, and that
    // match is the only thing that authorized deleting it. A delete narrower
    // than the select (device id alone) would silently leave every
    // anchor-matched row in place.
    ...duplicates.map((row) =>
      env.DB.prepare(`
        delete from machines
         where user_id = ? and machine_key = ? and (device_id = ? or hardware_id = ?)
      `).bind(userId, row.machine_key, matchDeviceId, matchHardwareId)
    ),
  ]);
  return duplicates.map((row) => row.machine_key);
}

async function handleRegister(
  request: Request,
  env: Env,
  userId: string,
  correlationId: string,
  relayOptions: ActivityRelayOptions,
  freshInteractiveAuthentication: boolean,
): Promise<Response> {
  if (request.method !== "POST") return text("method not allowed", 405);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid request body" }, { status: 400 });
  }
  const input = parseRegisterInput(raw);
  if (!input) return json({ error: "invalid request body" }, { status: 400 });

  const nowMs = Date.now();
  const refuse: RefusalLogger = (event, code, reason) => logDirectoryRefusal({
    event,
    userId,
    machineKey: input.machineKey,
    deviceId: input.deviceId,
    code,
    correlationId,
    reason,
  });
  // One owner for the two privileged operations below, so the grant behind them
  // is reserved at most once and spent at most once across both.
  const pairingProof = createPairingProofBroker(env, {
    userId,
    machineKey: input.machineKey,
    pairing: input.pairing,
    pairingGrant: input.pairingGrant,
    freshInteractiveAuthentication,
    nowMs,
  });

  const refusal = await enforceRevocationGate(request, env, {
    userId,
    input,
    correlationId,
    relayOptions,
    pairingProof,
    refuse,
  });
  if (refusal) return refusal;

  await upsertMachine(env, { userId, input, nowMs });

  const supersededMachineKeys = await supersedePhantomDuplicates(env, {
    userId,
    input,
    pairingProof,
    refuse,
  });

  const row = await env.DB.prepare(`
    select ${MACHINE_ROW_COLUMNS}
      from machines
     where user_id = ? and machine_key = ?
  `).bind(userId, input.machineKey).first<MachineRow>();
  if (!row) return json({ error: "machine was not stored" }, { status: 500 });
  // `supersededMachineKeys` is additive and omitted when empty, so a heartbeat
  // response is byte-identical to what every deployed client already parses.
  return json({
    ...machineRecord(row),
    ...(supersededMachineKeys.length > 0 ? { supersededMachineKeys } : {}),
  });
}

async function handleList(
  request: Request,
  env: Env,
  userId: string,
  authDurationMs: number,
): Promise<Response> {
  if (request.method !== "GET") return text("method not allowed", 405);
  const dbStartedAt = performance.now();
  const rows = (await env.DB.prepare(`
    select ${MACHINE_ROW_COLUMNS}
      from machines
     where user_id = ?
     -- 500 is the machine-directory cap, matching the client's effective cap.
     order by last_seen_at desc
     limit 500
  `).bind(userId).all<MachineRow>()).results ?? [];
  const dbDurationMs = performance.now() - dbStartedAt;
  const now = Date.now();
  const windowMs = onlineWindowMs(env);
  const machines = rows.map((row) => ({
    ...machineRecord(row),
    online: typeof row.last_seen_at === "number" && now - row.last_seen_at <= windowMs,
  })).sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    return Number(right.lastSeenAt ?? 0) - Number(left.lastSeenAt ?? 0);
  });
  return withServerTiming(json({ machines }), authDurationMs, dbDurationMs);
}

/**
 * Removing a machine is three things, not one: drop it from the roster, stop it
 * publishing again, and take its Activity with it. The feed lives in the push
 * relay (a different worker over a different D1) and its rows carry no expiry,
 * so a delete that stops at this table leaves a de-authorized machine's agents
 * on every surface of the account forever.
 */
async function handleDelete(
  request: Request,
  env: Env,
  userId: string,
  machineKey: string,
  correlationId: string,
  relayOptions: ActivityRelayOptions,
): Promise<Response> {
  if (request.method !== "DELETE") return text("method not allowed", 405);
  const existing = await env.DB.prepare(`
    select ${MACHINE_ROW_COLUMNS}
      from machines
     where user_id = ? and machine_key = ?
  `).bind(userId, machineKey).first<MachineRow>();
  // Record the revocation before dropping the row: if the write after it fails,
  // the machine is still listed but already blocked, and the user can retry.
  // The reverse order would leave a removed machine free to re-register.
  //
  // `coalesce` and not `excluded.device_id`: the retry the desktop tells the
  // user to run ("try removing it again" after a 502) re-enters here with the
  // `machines` row already gone, so `existing` is null. The first pass captured
  // the real id and later passes must not erase it — it is what the removal
  // audit trail (and support) reads to identify which install was removed.
  // Nothing on the register path branches on it: `deviceId` is caller-supplied,
  // so it can never authorize anything.
  await env.DB.prepare(`
    insert into revoked_machines(user_id, machine_key, device_id, revoked_at)
    values (?, ?, ?, ?)
    on conflict(user_id, machine_key) do update set
      device_id = coalesce(excluded.device_id, revoked_machines.device_id),
      revoked_at = excluded.revoked_at
  `).bind(userId, machineKey, existing?.device_id ?? null, Date.now()).run();
  await env.DB.prepare("delete from machines where user_id = ? and machine_key = ?")
    .bind(userId, machineKey)
    .run();

  const purged = await callActivityRelay(request, env, {
    operation: "purge",
    machineKey,
    correlationId,
    options: relayOptions,
  });
  if (!purged.ok) {
    // The machine is off the roster and blocked, but its Activity is still
    // there. Say so instead of reporting a clean removal the user can see is
    // untrue the next time they open Activity.
    logDirectoryRefusal({
      event: "directory.remove_refused",
      userId,
      machineKey,
      deviceId: existing?.device_id ?? null,
      code: "activity_purge_failed",
      correlationId,
      reason: purged.reason,
    });
    return json({
      ok: false,
      error: "activity purge failed",
      code: "activity_purge_failed",
      machineKey,
      machineRemoved: true,
      activityPurged: false,
      detail: purged.reason,
    }, { status: 502 });
  }
  return json({ ok: true, machineKey });
}

async function handleRename(
  request: Request,
  env: Env,
  userId: string,
  machineKey: string,
): Promise<Response> {
  if (request.method !== "PATCH") return text("method not allowed", 405);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid request body" }, { status: 400 });
  }
  if (!isRecord(raw) || !Object.hasOwn(raw, "customName")) {
    return json({ error: "invalid request body" }, { status: 400 });
  }
  const customName = optionalString(raw, "customName");
  if (customName === undefined || (customName?.length ?? 0) > MAX_CUSTOM_NAME_CHARS) {
    return json({ error: "invalid request body" }, { status: 400 });
  }

  const result = await env.DB.prepare(`
    update machines
       set custom_name = ?
     where user_id = ? and machine_key = ?
  `).bind(customName, userId, machineKey).run();
  if ((result.meta.changes ?? 0) === 0) {
    return json({ error: "machine not found" }, { status: 404 });
  }

  const row = await env.DB.prepare(`
    select ${MACHINE_ROW_COLUMNS}
      from machines
     where user_id = ? and machine_key = ?
  `).bind(userId, machineKey).first<MachineRow>();
  if (!row) return json({ error: "machine not found" }, { status: 404 });
  return json({
    ...machineRecord(row),
    online: typeof row.last_seen_at === "number"
      && Date.now() - row.last_seen_at <= onlineWindowMs(env),
  });
}

function trustedWebClientOrigin(env: Env): string | null {
  const raw = env.WEB_CLIENT_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.origin !== raw || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set(
    "access-control-expose-headers",
    "Server-Timing, X-ADE-Correlation-ID",
  );
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requestCorrelationId(request: Request): string {
  const provided = request.headers.get("x-ade-correlation-id")?.trim() ?? "";
  return CORRELATION_ID_PATTERN.test(provided)
    ? provided.toLowerCase()
    : crypto.randomUUID();
}

function withCorrelationId(response: Response, correlationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-ade-correlation-id", correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleRequestCore(
  request: Request,
  env: Env,
  options: DirectoryRequestOptions,
  correlationId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return request.method === "GET" ? json({ ok: true }) : text("method not allowed", 405);
  }

  const deviceResponse = await handleDeviceAuthorizationRequest(request, env, {
    ...options,
    // The device flow owns the sign-in; the grant it hands back is the pairing
    // module's concern, so the minting (and the Clerk verification it needs)
    // stays out of the device module.
    mintPairingGrant: options.mintPairingGrant ?? ((args) => mintPairingGrant(env, {
      ...args,
      nowMs: (options.now ?? Date.now)(),
    })),
  });
  if (deviceResponse) return deviceResponse;

  const route = routeAccount(url.pathname);
  if (!route) return text("not found", 404);
  const timeMachineList = route.kind === "list" && request.method === "GET";
  const authStartedAt = timeMachineList ? performance.now() : 0;
  const authentication = await authenticate(request, env);
  const authDurationMs = timeMachineList ? performance.now() - authStartedAt : 0;
  if (!authentication.ok) {
    const response = json(
      { error: authentication.reason },
      {
        status: authentication.reason === "authentication unavailable" ? 503 : 401,
      },
    );
    return timeMachineList
      ? withServerTiming(response, authDurationMs, 0)
      : response;
  }
  const userId = authentication.userId;

  const relayOptions = options.activityRelay ?? {};
  if (route.kind === "register") {
    return await handleRegister(
      request,
      env,
      userId,
      correlationId,
      relayOptions,
      authentication.freshInteractiveAuthentication,
    );
  }
  if (route.kind === "list") return await handleList(request, env, userId, authDurationMs);
  if (request.method === "PATCH") {
    return await handleRename(request, env, userId, route.machineKey);
  }
  return await handleDelete(
    request,
    env,
    userId,
    route.machineKey,
    correlationId,
    relayOptions,
  );
}

export async function handleRequest(
  request: Request,
  env: Env,
  options: DirectoryRequestOptions = {},
): Promise<Response> {
  const startedAt = performance.now();
  const correlationId = requestCorrelationId(request);
  const url = new URL(request.url);
  const route = routeAccount(url.pathname);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedWebClientOrigin(env);
  const corsOrigin = requestOrigin && allowedOrigin && requestOrigin === allowedOrigin
    ? allowedOrigin
    : null;
  const finish = (response: Response, applyCors = false): Response => {
    const correlatedResponse = withCorrelationId(response, correlationId);
    logDirectoryLifecycle({
      correlationId,
      route: route?.kind ?? null,
      method: request.method,
      status: correlatedResponse.status,
      durationMs: performance.now() - startedAt,
    });
    return applyCors && corsOrigin
      ? withCors(correlatedResponse, corsOrigin)
      : correlatedResponse;
  };
  if (request.method === "OPTIONS") {
    const allowedMethod = route?.kind === "list"
      ? "GET"
      : route?.kind === "machine"
        ? request.headers.get("access-control-request-method")?.toUpperCase() === "PATCH"
          ? "PATCH"
          : "DELETE"
        : null;
    if (!allowedMethod) return finish(text("not found", 404));
    if (!corsOrigin) return finish(text("origin not allowed", 403));
    if (request.headers.get("access-control-request-method")?.toUpperCase() !== allowedMethod) {
      return finish(text("method not allowed", 405));
    }
    const allowsJsonBody = allowedMethod === "PATCH";
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedHeaders.some((header) =>
      header !== "authorization"
        && !(allowsJsonBody && header === "content-type")
        && header !== "x-ade-correlation-id"
    )) {
      return finish(text("headers not allowed", 403));
    }
    return finish(new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": allowsJsonBody
          ? "authorization, content-type, x-ade-correlation-id"
          : "authorization, x-ade-correlation-id",
        "access-control-expose-headers": "X-ADE-Correlation-ID",
        "access-control-allow-methods": `${allowedMethod}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    }));
  }
  // Daemon/native callers omit Origin. Browser callers must match the one
  // configured hosted client exactly; reject hostile origins before auth or D1.
  if (requestOrigin && routeAccount(url.pathname) && !corsOrigin) {
    return finish(text("origin not allowed", 403));
  }
  const response = await handleRequestCore(request, env, options, correlationId);
  return finish(response, Boolean(corsOrigin));
}
