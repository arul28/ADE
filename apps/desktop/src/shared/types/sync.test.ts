import { describe, expect, it } from "vitest";
import {
  competingSyncHostSkipReason,
  createSyncAccountDirectoryHealth,
  describeUnpublishedAccountDirectory,
  readCompetingSyncHostOwner,
} from "./sync";

/**
 * The publisher can fail to reach the directory, or the directory can answer
 * and refuse this machine. Both used to read "can't reach your ADE account right
 * now, retrying" — wrong for a refusal, because the account was reached and it
 * answered. The refusal code rides `lastHttpReason`; these pin every branch.
 */
describe("describeUnpublishedAccountDirectory http_error refusal branches", () => {
  it("names the removal when the directory refused because this machine was revoked", () => {
    const health = createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 403,
      lastHttpReason: "machine_revoked",
    });
    expect(describeUnpublishedAccountDirectory("http_error", health)).toEqual({
      summary: "this computer was removed from your ADE account",
      nextAction: "Reconnect this computer",
    });
  });

  it("asks for a fresh sign-in when the directory demands one", () => {
    const health = createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 403,
      lastHttpReason: "pairing_authentication_required",
    });
    expect(describeUnpublishedAccountDirectory("http_error", health)).toEqual({
      summary: "sign in again to reconnect this computer",
      nextAction: "Sign in again",
    });
  });

  it("keeps the reachability text for every other HTTP failure", () => {
    const serverError = createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 500,
      lastHttpReason: null,
    });
    expect(describeUnpublishedAccountDirectory("http_error", serverError)).toEqual({
      summary: "can't reach your ADE account right now, retrying",
      nextAction: null,
    });
    // A caller with only the state (the CLI) keeps the same text.
    expect(describeUnpublishedAccountDirectory("http_error")).toEqual({
      summary: "can't reach your ADE account right now, retrying",
      nextAction: null,
    });
  });
});

/**
 * On one Mac, the release ADE and ADE Alpha both run. One owns the machine-wide
 * sync-host lease; the other cannot publish. "another ADE app owns sync" is
 * truthful but not actionable — the owner's name and pid are what let someone
 * quit the right app, and this is the only state that carries them.
 */
describe("describeUnpublishedAccountDirectory competing sync host", () => {
  it("names the owning app and pid and says how to end it", () => {
    const health = createSyncAccountDirectoryHealth(
      "no_active_sync_scope",
      competingSyncHostSkipReason({ appName: "ADE Alpha", pid: 9253 }),
    );
    expect(describeUnpublishedAccountDirectory("no_active_sync_scope", health)).toEqual({
      summary: "another ADE app on this computer owns sync for this machine (ADE Alpha, pid 9253)",
      nextAction: "Quit that ADE to let this one host sync.",
    });
  });

  it("round-trips the owner through the publisher skipReason", () => {
    expect(
      readCompetingSyncHostOwner(
        createSyncAccountDirectoryHealth(
          "no_active_sync_scope",
          competingSyncHostSkipReason({ appName: "ADE Beta", pid: 4242 }),
        ),
      ),
    ).toEqual({ appName: "ADE Beta", pid: 4242 });
  });

  it("keeps the generic sentence when the owner is unknown", () => {
    // An older brain, or a genuinely unreadable lock. The state is still
    // truthful and the CLI still has the one command that can show the detail.
    expect(describeUnpublishedAccountDirectory("no_active_sync_scope")).toEqual({
      summary: "another ADE app on this computer owns sync for this machine",
      nextAction: "ade doctor",
    });
    expect(readCompetingSyncHostOwner(
      createSyncAccountDirectoryHealth("no_active_sync_scope", "No active sync scope is available."),
    )).toBeNull();
  });
});
