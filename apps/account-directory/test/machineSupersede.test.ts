import { describe, expect, it } from "vitest";
import { handleRequest, MAX_SUPERSEDED_MACHINES } from "../src/directory";
import {
  completeDeviceLogin,
  makeEnv,
  mintFreshAuthToken,
  mintToken,
  registerBody,
  request,
} from "./helpers";

/**
 * Phantom duplicates. A client that rotates its machine key — a reinstall, a
 * wiped config directory, a restored backup — lands as a SECOND row for one
 * physical computer, because rows are keyed `(user_id, machine_key)`. The user
 * then removes the row that looks stale, and half the time that is the live
 * install: the incident this whole change exists to stop.
 */
describe("device supersede", () => {
  const DEVICE_ID = "device-macbook";

  function registerForDevice(
    machineKey: string,
    body: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { ...registerBody(machineKey), deviceId: DEVICE_ID, ...body };
  }

  it("folds a reinstalled machine's old key into the new one on a proven re-pair", async () => {
    const env = makeEnv();
    const staleToken = await mintToken({ sub: "user_1" });
    await handleRequest(
      request("POST", "/account/machines/register", staleToken, registerForDevice("machine-old")),
      env,
    );

    // The reinstall: same computer, new identity file, and a human who just
    // signed in to produce it.
    const reinstalled = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );

    expect(reinstalled.status).toBe(200);
    expect(await reinstalled.json()).toMatchObject({
      machineKey: "machine-new",
      supersededMachineKeys: ["machine-old"],
    });
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
    // No revocation for the superseded key. The physical device holds the new
    // one; blocking the old would trapdoor any client that rolls its identity
    // file back into a permanent refusal.
    expect(env.DB.revocations).toEqual([]);
  });

  it("carries the name the user typed onto the row that replaces it", async () => {
    const env = makeEnv();
    const staleToken = await mintToken({ sub: "user_1" });
    await handleRequest(
      request("POST", "/account/machines/register", staleToken, registerForDevice("machine-old")),
      env,
    );
    await handleRequest(
      request("PATCH", "/account/machines/machine-old", staleToken, { customName: "Studio Mac" }),
      env,
    );

    const reinstalled = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );

    // A rename is a deliberate act the client cannot reconstruct, so folding
    // the row without it silently renames the user's computer back to its
    // hostname — the reinstall looks like it lost something, because it did.
    expect(await reinstalled.json()).toMatchObject({
      machineKey: "machine-new",
      customName: "Studio Mac",
      supersededMachineKeys: ["machine-old"],
    });
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
  });

  it("never overwrites a name already set on the surviving row", async () => {
    const env = makeEnv();
    const staleToken = await mintToken({ sub: "user_1" });
    for (const machineKey of ["machine-old", "machine-new"]) {
      await handleRequest(
        request("POST", "/account/machines/register", staleToken, registerForDevice(machineKey)),
        env,
      );
    }
    await handleRequest(
      request("PATCH", "/account/machines/machine-old", staleToken, { customName: "Old Name" }),
      env,
    );
    await handleRequest(
      request("PATCH", "/account/machines/machine-new", staleToken, { customName: "New Name" }),
      env,
    );

    const reinstalled = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );

    // The name on the surviving row is the fresher statement of intent; the
    // carry-forward only ever fills an empty one.
    expect(await reinstalled.json()).toMatchObject({
      customName: "New Name",
      supersededMachineKeys: ["machine-old"],
    });
  });

  it("takes the newest name when several superseded rows carry one", async () => {
    const env = makeEnv();
    const staleToken = await mintToken({ sub: "user_1" });
    for (const machineKey of ["machine-older", "machine-newer"]) {
      await handleRequest(
        request("POST", "/account/machines/register", staleToken, registerForDevice(machineKey)),
        env,
      );
      await handleRequest(
        request("PATCH", `/account/machines/${machineKey}`, staleToken, {
          customName: `name of ${machineKey}`,
        }),
        env,
      );
    }

    const reinstalled = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );

    // Rows arrive oldest-seen first, so the most recently used phantom is the
    // one whose name the user still recognizes.
    expect(await reinstalled.json()).toMatchObject({ customName: "name of machine-newer" });
  });

  it("deletes every superseded row in one batch, name carry-forward included", async () => {
    const env = makeEnv();
    const staleToken = await mintToken({ sub: "user_1" });
    for (let index = 0; index < 3; index += 1) {
      await handleRequest(
        request("POST", "/account/machines/register", staleToken, registerForDevice(`machine-old-${index}`)),
        env,
      );
    }
    await handleRequest(
      request("PATCH", "/account/machines/machine-old-0", staleToken, { customName: "Studio Mac" }),
      env,
    );

    await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );

    // The grant is already spent by the time these run, so a sequential loop
    // that failed partway would leave half the phantoms deleted with no
    // credential left to finish the job. One batch, one transaction.
    expect(env.DB.batchedStatementCounts).toEqual([4]);
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
  });

  it("leaves duplicates alone for a plain-token register", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await handleRequest(
      request("POST", "/account/machines/register", token, registerForDevice("machine-old")),
      env,
    );

    // `deviceId` is caller-supplied. Without proof of a fresh human, honoring
    // it would let any machine name another's device id and delete its row.
    const rotated = await handleRequest(
      request("POST", "/account/machines/register", token, registerForDevice("machine-new", {
        // Even asserting intent changes nothing: the flag is client-supplied too.
        pairing: true,
      })),
      env,
    );

    expect(rotated.status).toBe(200);
    expect(await rotated.json()).not.toHaveProperty("supersededMachineKeys");
    expect(env.DB.rows.map((row) => row.machine_key).sort()).toEqual(["machine-new", "machine-old"]);
  });

  it("supersedes on a grant-backed pairing register and spends the grant exactly once", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await handleRequest(
      request("POST", "/account/machines/register", token, registerForDevice("machine-old")),
      env,
    );
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-new" });

    const rotated = await handleRequest(
      request("POST", "/account/machines/register", token, registerForDevice("machine-new", {
        pairing: true,
        pairingGrant: grant,
      })),
      env,
    );

    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({ supersededMachineKeys: ["machine-old"] });
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
    expect(env.DB.pairingGrants).toEqual([]);
  });

  it("never supersedes across accounts", async () => {
    const env = makeEnv();
    const other = await mintToken({ sub: "user_2" });
    await handleRequest(
      request("POST", "/account/machines/register", other, registerForDevice("machine-old")),
      env,
    );

    const mine = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );

    expect(await mine.json()).not.toHaveProperty("supersededMachineKeys");
    expect(env.DB.rows.map((row) => row.machine_key).sort()).toEqual(["machine-new", "machine-old"]);
  });

  it("supersedes at most five rows per call and finishes the job on the next one", async () => {
    const env = makeEnv();
    const staleToken = await mintToken({ sub: "user_1" });
    for (let index = 0; index < 7; index += 1) {
      await handleRequest(
        request("POST", "/account/machines/register", staleToken, registerForDevice(`machine-old-${index}`)),
        env,
      );
    }

    const first = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );

    // One request must never delete an unbounded slice of the roster.
    expect(((await first.json()) as { supersededMachineKeys: string[] }).supersededMachineKeys)
      .toHaveLength(MAX_SUPERSEDED_MACHINES);
    expect(env.DB.rows).toHaveLength(3);

    const second = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerForDevice("machine-new"),
      ),
      env,
    );
    expect(((await second.json()) as { supersededMachineKeys: string[] }).supersededMachineKeys)
      .toHaveLength(2);
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
  });
});

/**
 * The other half of the reinstall story, and the half device-supersede could
 * not reach.
 *
 * `sync-device-id` lives in `~/.ade/secrets` next to the machine key, so the
 * user who follows the oldest support instruction there is — delete `~/.ade`,
 * install again, sign in — arrives with BOTH identifiers freshly minted and
 * nothing for the directory to match. `hardware_id` is derived from the machine
 * itself and is the same on the other side of that wipe.
 *
 * It is caller-supplied like the device id, so it is gated by the identical
 * proof and nothing here relaxes that.
 */
describe("hardware anchor supersede", () => {
  // What a client actually sends: sha256 hex, salted per account, so these two
  // stand for the same computer seen by two different accounts.
  const ANCHOR = "a".repeat(64);
  const OTHER_ACCOUNT_ANCHOR = "b".repeat(64);

  function registerWithAnchor(
    machineKey: string,
    body: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { ...registerBody(machineKey), hardwareId: ANCHOR, ...body };
  }

  it("persists the anchor and never lets a blank heartbeat erase it", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });

    await handleRequest(
      request("POST", "/account/machines/register", token, registerWithAnchor("machine-a")),
      env,
    );
    expect(env.DB.rows[0]?.hardware_id).toBe(ANCHOR);

    // A host that momentarily cannot read its identifier still heartbeats. The
    // stored anchor is what a later reinstall matches on, so one bad sample
    // must not cost the row its only durable identity.
    const blank = await handleRequest(
      request("POST", "/account/machines/register", token, registerBody("machine-a")),
      env,
    );
    expect(blank.status).toBe(200);
    expect(env.DB.rows[0]?.hardware_id).toBe(ANCHOR);
    // Nor is it echoed back: the roster has no use for it and the response is
    // the one place it could leak to another surface.
    expect(await blank.json()).not.toHaveProperty("hardwareId");
  });

  it("folds a wiped install's row in when the device id did not survive either", async () => {
    const env = makeEnv();
    await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintToken({ sub: "user_1" }),
        registerWithAnchor("machine-old", { deviceId: "device-before-the-wipe" }),
      ),
      env,
    );

    // `rm -rf ~/.ade`, reinstall, sign in: new machine key, NEW DEVICE ID, and
    // the same computer underneath. Device-supersede alone matches nothing here.
    const reinstalled = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerWithAnchor("machine-new", { deviceId: "device-after-the-wipe" }),
      ),
      env,
    );

    expect(reinstalled.status).toBe(200);
    expect(await reinstalled.json()).toMatchObject({
      machineKey: "machine-new",
      supersededMachineKeys: ["machine-old"],
    });
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
    expect(env.DB.revocations).toEqual([]);
  });

  it("refuses an anchor match on a plain token", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await handleRequest(
      request("POST", "/account/machines/register", token, registerWithAnchor("machine-old", {
        deviceId: "device-before-the-wipe",
      })),
      env,
    );

    // An anchor is no more attested than a device id. Honoring one without a
    // proven-fresh human would let any machine claim another's hardware and
    // delete its row.
    const rotated = await handleRequest(
      request("POST", "/account/machines/register", token, registerWithAnchor("machine-new", {
        deviceId: "device-after-the-wipe",
        pairing: true,
      })),
      env,
    );

    expect(rotated.status).toBe(200);
    expect(await rotated.json()).not.toHaveProperty("supersededMachineKeys");
    expect(env.DB.rows.map((row) => row.machine_key).sort()).toEqual(["machine-new", "machine-old"]);
  });

  it("supersedes an anchor match on a grant-backed pairing register", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    await handleRequest(
      request("POST", "/account/machines/register", token, registerWithAnchor("machine-old", {
        deviceId: "device-before-the-wipe",
      })),
      env,
    );
    const { grant } = await completeDeviceLogin(env, { machineKey: "machine-new" });

    const rotated = await handleRequest(
      request("POST", "/account/machines/register", token, registerWithAnchor("machine-new", {
        deviceId: "device-after-the-wipe",
        pairing: true,
        pairingGrant: grant,
      })),
      env,
    );

    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({ supersededMachineKeys: ["machine-old"] });
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
    expect(env.DB.pairingGrants).toEqual([]);
  });

  it("still folds a null-anchor row in through the device id", async () => {
    const env = makeEnv();
    // Written before this shipped: no anchor at all, and nothing back-fills one.
    await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintToken({ sub: "user_1" }),
        { ...registerBody("machine-legacy"), deviceId: "device-macbook" },
      ),
      env,
    );
    expect(env.DB.rows[0]?.hardware_id).toBeNull();

    // An in-place reinstall keeps `~/.ade/secrets`, so the device id is still
    // the identifier that matches. The anchor path must not have cost it that.
    const reinstalled = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerWithAnchor("machine-new", { deviceId: "device-macbook" }),
      ),
      env,
    );

    expect(await reinstalled.json()).toMatchObject({ supersededMachineKeys: ["machine-legacy"] });
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
  });

  it("never matches an anchor across accounts", async () => {
    const env = makeEnv();
    // The salt makes this impossible to produce in the field; the query being
    // user-scoped is what makes it impossible even if it were produced.
    await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintToken({ sub: "user_2" }),
        registerWithAnchor("machine-theirs", { deviceId: "device-theirs" }),
      ),
      env,
    );

    const mine = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerWithAnchor("machine-mine", { deviceId: "device-mine" }),
      ),
      env,
    );

    expect(await mine.json()).not.toHaveProperty("supersededMachineKeys");
    expect(env.DB.rows.map((row) => row.machine_key).sort())
      .toEqual(["machine-mine", "machine-theirs"]);
  });

  it("leaves another account's row alone even when it holds a different anchor", async () => {
    const env = makeEnv();
    await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintToken({ sub: "user_2" }),
        registerWithAnchor("machine-theirs", {
          deviceId: "device-macbook",
          hardwareId: OTHER_ACCOUNT_ANCHOR,
        }),
      ),
      env,
    );

    // Same physical machine, second account: the device id is genuinely shared,
    // and the row still belongs to somebody else.
    const mine = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerWithAnchor("machine-mine", { deviceId: "device-macbook" }),
      ),
      env,
    );

    expect(await mine.json()).not.toHaveProperty("supersededMachineKeys");
    expect(env.DB.rows).toHaveLength(2);
  });

  it("caps the union of both identifiers at five rows per call", async () => {
    const env = makeEnv();
    const staleToken = await mintToken({ sub: "user_1" });
    // Three phantoms reachable only by device id, three only by anchor: the cap
    // has to bind across the union, not once per identifier.
    for (let index = 0; index < 3; index += 1) {
      await handleRequest(
        request("POST", "/account/machines/register", staleToken, registerWithAnchor(`machine-device-${index}`, {
          deviceId: "device-macbook",
          hardwareId: null,
        })),
        env,
      );
      await handleRequest(
        request("POST", "/account/machines/register", staleToken, registerWithAnchor(`machine-anchor-${index}`, {
          deviceId: `device-wiped-${index}`,
        })),
        env,
      );
    }

    const first = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerWithAnchor("machine-new", { deviceId: "device-macbook" }),
      ),
      env,
    );

    expect(((await first.json()) as { supersededMachineKeys: string[] }).supersededMachineKeys)
      .toHaveLength(MAX_SUPERSEDED_MACHINES);
    expect(env.DB.rows).toHaveLength(2);

    const second = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintFreshAuthToken("user_1"),
        registerWithAnchor("machine-new", { deviceId: "device-macbook" }),
      ),
      env,
    );
    expect(((await second.json()) as { supersededMachineKeys: string[] }).supersededMachineKeys)
      .toHaveLength(1);
    expect(env.DB.rows.map((row) => row.machine_key)).toEqual(["machine-new"]);
  });

  it("rejects an oversized anchor rather than storing it", async () => {
    const env = makeEnv();
    const response = await handleRequest(
      request(
        "POST",
        "/account/machines/register",
        await mintToken({ sub: "user_1" }),
        registerWithAnchor("machine-a", { hardwareId: "x".repeat(129) }),
      ),
      env,
    );

    expect(response.status).toBe(400);
    expect(env.DB.rows).toEqual([]);
  });
});
