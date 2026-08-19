import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/directory";
import {
  cleanupExpiredPairingGrants,
  PAIRING_GRANT_RESERVATION_MS,
  PAIRING_GRANT_TTL_MS,
} from "../src/pairingGrants";
import {
  activityRelayStub,
  completeDeviceLogin,
  makeEnv,
  mintFreshAuthToken,
  mintToken,
  pairingRequest,
  registerBody,
  RELAY_URL,
  removedMachine,
  request,
} from "./helpers";

/**
 * The second, independent proof that a `pairing: true` registration is backed
 * by a human who just signed in.
 *
 * It exists because the first proof — an `auth_time`/`fva` claim on the
 * caller's own token — fails CLOSED, and the ADE brain authenticates with a
 * Clerk OAuth access token whose documented claim set contains neither. A
 * claim-only gate would therefore risk making every account removal permanent.
 * Every test here mints its tokens WITHOUT a freshness claim, so the grant is
 * the only thing that can be doing the work.
 */
describe("device-login pairing grants", () => {
  it("mints a grant only for a device login that declared a machine key", async () => {
    const withMachine = makeEnv();
    const withMachineResult = await completeDeviceLogin(withMachine, { machineKey: "machine-a" });
    expect(withMachineResult.grant).toEqual(expect.any(String));
    expect(withMachine.DB.pairingGrants).toHaveLength(1);
    expect(withMachine.DB.pairingGrants[0]).toMatchObject({
      user_id: "user_1",
      machine_key: "machine-a",
    });
    // Only the hash is stored: a dump of this table must yield nothing spendable.
    expect(withMachine.DB.pairingGrants[0]?.grant_hash).not.toBe(withMachineResult.grant);

    const withoutMachine = makeEnv();
    const withoutMachineResult = await completeDeviceLogin(withoutMachine);
    expect(withoutMachineResult.grant).toBeNull();
    expect(withoutMachine.DB.pairingGrants).toEqual([]);
  });

  it("accepts a grant as proof for a machine whose token carries no freshness claim", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-a" });

    // Same stale token that was just refused a moment ago — only the grant is new.
    const staleWithoutGrant = await handleRequest(pairingRequest(token, {}), env, relay.options);
    expect(staleWithoutGrant.status).toBe(403);
    expect(await staleWithoutGrant.json()).toMatchObject({
      code: "pairing_authentication_required",
    });
    expect(relay.calls).toEqual([]);

    const repaired = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(repaired.status).toBe(200);
    expect(env.DB.revocations).toEqual([]);
    expect(relay.calls.at(-1)).toMatchObject({
      url: `${RELAY_URL}/attention/account/machines/machine-a/pairing`,
      method: "POST",
    });
  });

  it("refuses a replayed grant", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-a" });

    const first = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(first.status).toBe(200);
    expect(env.DB.pairingGrants).toEqual([]);

    // Remove it again, then try to re-pair with the grant that was already spent.
    await handleRequest(
      request("DELETE", "/account/machines/machine-a", token),
      env,
      relay.options,
    );
    relay.calls.length = 0;
    const replay = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: "pairing_authentication_required" });
    expect(relay.calls).toEqual([]);
    expect(env.DB.revocations).toHaveLength(1);
  });

  it("refuses an expired grant", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, {
      machineKey: "machine-a",
      now: Date.now() - (PAIRING_GRANT_TTL_MS + 60_000),
    });
    expect(grant).toEqual(expect.any(String));

    const attempt = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(attempt.status).toBe(403);
    expect(await attempt.json()).toMatchObject({ code: "pairing_authentication_required" });
    expect(relay.calls).toEqual([]);
    // Refused, not silently spent: an expired grant is not a usable credential
    // for anyone, so leaving it for the cron sweep changes nothing.
    expect(env.DB.revocations).toHaveLength(1);
  });

  it("refuses a grant minted for a different machine key", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-b" });

    const attempt = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(attempt.status).toBe(403);
    expect(await attempt.json()).toMatchObject({ code: "pairing_authentication_required" });
    expect(relay.calls).toEqual([]);
    expect(env.DB.revocations).toHaveLength(1);
    // Untouched: another machine's re-pair must still be able to spend it.
    expect(env.DB.pairingGrants).toHaveLength(1);
  });

  it("refuses a grant minted for a different user", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    // A second account signs in on a machine that happens to share the key.
    const { grant } = await completeDeviceLogin(env, {
      machineKey: "machine-a",
      sub: "user_2",
    });

    const attempt = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(attempt.status).toBe(403);
    expect(await attempt.json()).toMatchObject({ code: "pairing_authentication_required" });
    expect(relay.calls).toEqual([]);
    expect(env.DB.revocations).toHaveLength(1);
    expect(env.DB.pairingGrants).toHaveLength(1);
  });

  it("refuses a forged grant and never lets one substitute for the pairing flag", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-a" });

    const forged = await handleRequest(
      pairingRequest(token, { pairingGrant: "not-a-real-grant" }),
      env,
      relay.options,
    );
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ code: "pairing_authentication_required" });

    // A valid grant on a plain heartbeat is still just a heartbeat: `pairing`
    // is what declares intent, and its absence means the machine stays removed.
    const heartbeat = await handleRequest(request(
      "POST",
      "/account/machines/register",
      token,
      { ...registerBody("machine-a"), pairingGrant: grant },
    ), env, relay.options);
    expect(heartbeat.status).toBe(403);
    expect(await heartbeat.json()).toMatchObject({ code: "machine_revoked" });
    expect(relay.calls).toEqual([]);
    expect(env.DB.pairingGrants).toHaveLength(1);
  });

  it("does not spend a grant when the token already proves a fresh sign-in", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-a" });

    const repaired = await handleRequest(
      pairingRequest(await mintFreshAuthToken("user_1"), { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(repaired.status).toBe(200);
    // The claim is the fast path; the fallback must stay unspent behind it.
    expect(env.DB.pairingGrants).toHaveLength(1);
  });

  it("tells the user what to do instead of only refusing", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);

    const refusal = await handleRequest(pairingRequest(token, {}), env, relay.options);
    expect(refusal.status).toBe(403);
    // This string is what the desktop's reconnect banner and `ade` both surface,
    // so it has to name the action rather than describe the failure.
    expect(await refusal.json()).toEqual({
      error: "Sign in again on this computer to reconnect it to your ADE account",
      code: "pairing_authentication_required",
      revokedAt: expect.any(Number),
    });
  });

  it("sweeps expired grants and keeps live ones", async () => {
    const env = makeEnv();
    const now = Date.now();
    await completeDeviceLogin(env, { machineKey: "machine-live", now });
    await completeDeviceLogin(env, {
      machineKey: "machine-dead",
      now: now - (PAIRING_GRANT_TTL_MS + 60_000),
    });
    expect(env.DB.pairingGrants).toHaveLength(2);

    await expect(cleanupExpiredPairingGrants(env, now)).resolves.toBe(1);
    expect(env.DB.pairingGrants.map((row) => row.machine_key)).toEqual(["machine-live"]);
  });
});

/**
 * A grant is the ONLY way back for a machine whose token carries no freshness
 * claim, so destroying one on a failure the user did not cause is the same
 * lockout the grant was introduced to prevent. Redemption is therefore two
 * phases — reserve, then consume or release — and these tests hold both the
 * safety property (single-use survives) and the liveness property (an outage
 * costs a retry, not a credential) at once.
 */
describe("two-phase pairing-grant redemption", () => {
  it("returns the grant unchanged when the relay hand-off fails, then lets the retry spend it", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-a" });
    const mintedExpiry = env.DB.pairingGrants[0]!.expires_at;

    const failing = activityRelayStub(() => new Response("down", { status: 503 }));
    const outage = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      failing.options,
    );

    expect(outage.status).toBe(503);
    expect(await outage.json()).toMatchObject({ code: "activity_relay_unavailable" });
    expect(env.DB.revocations).toHaveLength(1);
    // Back exactly as it was. `expires_at` is the load-bearing assertion: a
    // release that re-issued the grant with a fresh TTL would let anyone who
    // can force relay failures keep one alive indefinitely.
    expect(env.DB.pairingGrants).toHaveLength(1);
    expect(env.DB.pairingGrants[0]).toMatchObject({
      reserved_at: null,
      expires_at: mintedExpiry,
    });

    // The retry the refusal implies now works, with no second sign-in.
    const retry = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(retry.status).toBe(200);
    expect(env.DB.revocations).toEqual([]);
    // Consumed on success: two phases must not become two chances.
    expect(env.DB.pairingGrants).toEqual([]);
  });

  it("ignores a reservation left behind by a crashed worker but honors a live one", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const relay = await removedMachine(env, token);
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-a" });

    // Another registration is mid-relay with this grant right now. Single-use
    // is what the reservation is for, so this one gets nothing.
    env.DB.pairingGrants[0]!.reserved_at = Date.now();
    const contended = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(contended.status).toBe(403);
    expect(await contended.json()).toMatchObject({ code: "pairing_authentication_required" });
    expect(relay.calls).toEqual([]);
    expect(env.DB.pairingGrants).toHaveLength(1);

    // Same row, but the holder died without consuming or releasing it. Without
    // the staleness bound the grant would now be unspendable until it expired
    // — a lockout with extra steps.
    env.DB.pairingGrants[0]!.reserved_at = Date.now() - (PAIRING_GRANT_RESERVATION_MS + 1_000);
    const recovered = await handleRequest(
      pairingRequest(token, { pairingGrant: grant }),
      env,
      relay.options,
    );
    expect(recovered.status).toBe(200);
    expect(env.DB.pairingGrants).toEqual([]);
    expect(env.DB.revocations).toEqual([]);
  });
});
