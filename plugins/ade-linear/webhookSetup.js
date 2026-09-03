// Registering this plugin's Linear webhook, and reporting on it.
//
// The paste box is gone. A reader used to be told to open Linear's settings,
// create a webhook by hand against a URL ADE printed, copy the signing secret
// Linear shows once, and paste it back — four steps across two apps, with a
// secret that is unrecoverable if the paste is missed.
//
// This is the compiled path instead (`linearIngressService.ts:288`): ADE
// generates the secret, creates the webhook THROUGH the Linear API on the
// authorization the reader already granted, and stores the secret in the same
// act. The reader presses Register.
//
// ## Why it needs the OAuth grant
//
// Linear delivers a data-change webhook only to an authorization carrying
// `admin`, and `webhookCreate` needs the same. Both of this plugin's OAuth
// clients ask for it (`connect.js:286`); a personal API key carries no OAuth
// grant at all. So an API-key connection is refused HERE, in one sentence that
// names the fix, rather than being allowed to create a hook Linear will never
// post to.
//
// ## Why the secret is generated rather than read back
//
// Linear shows a webhook's signing secret at creation and never again. A
// registration whose secret this plugin does not hold is a registration whose
// every delivery the host drops — the manifest declares `verify`, and
// `pluginWebhookIngressService` fails closed. So the flow that creates the hook
// is the flow that stores the secret, and a hook found at the same URL whose
// secret is NOT stored is rotated rather than adopted: its secret is
// unknowable, and adopting it would mean registering silence.

"use strict";

const { randomBytes } = require("node:crypto");

/** The channel id `plugin.json` declares under `webhookIngress`. */
const CHANNEL_ID = "linear";

/** The host secret name `plugin.json` names in `webhookIngress[].verify`. */
const SECRET_NAME = "LINEAR_WEBHOOK_SECRET";

/** Where the registration record lives. One row, so one fixed key. */
const REGISTRATION_COLLECTION = "webhook";
const REGISTRATION_KEY = "registration";

/**
 * What Linear is asked to send.
 *
 * The compiled list (`linearIngressService.ts:55`), unchanged. `Comment` is in
 * it even though this plugin fires no comment trigger: the deliveries feed the
 * issue refetch as well as the triggers, and a comment is a change to the issue
 * a reader is looking at.
 */
const RESOURCE_TYPES = Object.freeze(["Issue", "Comment", "IssueLabel"]);

/** How the hook names itself in Linear's own settings list. */
const WEBHOOK_LABEL = "ADE automations";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Trailing slashes off, so two spellings of one endpoint compare equal. */
function normalizeUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/**
 * "2026-09-01 12:00 UTC", or null.
 *
 * The same formatting the settings panel does, in one place, because the page
 * reads a sentence rather than an ISO string it would format a second way.
 */
function formatLastEvent(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Build the setup verbs.
 *
 * `sdk`, `api` and `connect` are injected, so both verbs are testable against a
 * fake host and a fake Linear with no network anywhere.
 */
function createWebhookSetup(options = {}) {
  const { sdk, api, connect, log = () => {} } = options;
  if (!sdk || !api || !connect) throw new TypeError("createWebhookSetup needs sdk, api and connect");

  /** The stored registration, or null. Never throws — a missing row is "none". */
  async function readRegistration() {
    try {
      const stored = await sdk.collections.get(REGISTRATION_COLLECTION, REGISTRATION_KEY);
      if (!stored || typeof stored !== "object") return null;
      const webhookId = text(stored.webhookId);
      return webhookId ? { webhookId, url: text(stored.url), registeredAt: text(stored.registeredAt) } : null;
    } catch {
      return null;
    }
  }

  async function writeRegistration(record) {
    await sdk.collections.put(REGISTRATION_COLLECTION, REGISTRATION_KEY, record);
  }

  /** The relay endpoint the host owns, or null when the host offers none. */
  async function endpointUrl() {
    try {
      return text(await sdk.webhooks.url(CHANNEL_ID));
    } catch {
      return null;
    }
  }

  /**
   * Whether this connection can carry a webhook at all.
   *
   * `clientSource` is the OAuth client the sign-in used; an API-key connection
   * has none. Same question `index.js:webhooksReachable` asks, asked here
   * because refusing early is the whole point of this check.
   */
  async function grantState() {
    const status = await connect.connectStatus().catch(() => ({}));
    const source = status?.clientSource ?? null;
    return {
      connected: status?.connected === true,
      oauth: source === "official" || source === "custom",
    };
  }

  /**
   * Registered, receiving, or broken — in one object the tile draws.
   *
   * Four different facts, kept apart rather than collapsed into one word,
   * because they fail independently and each has its own fix:
   *
   *  - `registered` — a hook exists at ADE's URL and this plugin holds its
   *    secret. Nothing arrives without it.
   *  - `lastEvent` / `pendingDeliveries` — the host's delivery ledger. Whether
   *    anything is actually ARRIVING, which a registration cannot promise.
   *  - `error` — the host's own drain failure, or the reason a register was
   *    refused.
   */
  async function webhookStatus() {
    const url = await endpointUrl();
    const grant = await grantState();
    const registration = await readRegistration();
    const secretStored = Boolean(await sdk.secrets.get(SECRET_NAME).catch(() => null));
    // Read only when an endpoint EXISTS: with no URL there is nothing for
    // Linear to post to, and a ledger read there answers zeros a tile would
    // draw as a healthy silence.
    const ledger = url ? await sdk.webhooks.status().catch(() => null) : null;
    const registered = Boolean(registration && secretStored);
    return {
      ok: true,
      registered,
      webhookId: registration?.webhookId ?? null,
      registeredAt: registration?.registeredAt ?? null,
      url,
      secretStored,
      connected: grant.connected,
      // The tile draws Register only where pressing it can work.
      canRegister: grant.connected && grant.oauth && Boolean(url),
      webhooksPossible: grant.oauth,
      lastEvent: formatLastEvent(ledger?.lastReceivedAt),
      pendingDeliveries: Number(ledger?.pendingDeliveries) || 0,
      error: text(ledger?.lastError),
      status: !grant.connected
        ? "Connect Linear first"
        : !grant.oauth
          ? "Linear will not deliver to an API key"
          : !url
            ? "This machine hosts no webhook endpoint"
            : registered
              ? "Registered"
              : "Not registered",
    };
  }

  /**
   * Create the webhook and store its secret.
   *
   * Idempotent by rotation, not by adoption. A hook already sitting at ADE's
   * URL whose secret this plugin still holds is left alone; every other hook at
   * that URL is deleted and replaced, because a secret Linear will not show
   * again is a secret this plugin cannot verify against.
   *
   * A creation that fails AFTER the hook exists deletes it again, so a retry
   * does not leave a second dead hook in the reader's Linear settings.
   */
  async function registerWebhook() {
    const grant = await grantState();
    if (!grant.connected) {
      return { ok: false, message: "Connect Linear before registering the webhook." };
    }
    if (!grant.oauth) {
      return {
        ok: false,
        message: "Linear sends webhooks only to an OAuth authorization. Sign in with Linear instead of pasting an API key.",
      };
    }
    const url = await endpointUrl();
    if (!url) {
      return { ok: false, message: "This machine hosts no webhook endpoint for Linear to post to." };
    }

    const registration = await readRegistration();
    const storedSecret = await sdk.secrets.get(SECRET_NAME).catch(() => null);

    let existing = [];
    try {
      existing = await api.listWebhooks();
    } catch (error) {
      return { ok: false, message: error?.message ?? "Could not read this workspace's Linear webhooks." };
    }

    const matching = existing.filter((hook) => normalizeUrl(hook.url) === normalizeUrl(url));
    const keepable = registration && storedSecret
      ? matching.find((hook) => hook.id === registration.webhookId && hook.enabled) ?? null
      : null;

    if (keepable) {
      // Everything already holds. Answering the status rather than recreating
      // means a reader who presses Register twice does not rotate a secret that
      // was working.
      return { ok: true, message: "Linear is already delivering to ADE.", ...(await webhookStatus()) };
    }

    // Every hook at this URL whose secret is unknowable, gone. Left in place
    // they would keep delivering bodies the host drops unverified, which reads
    // in Linear's own log as a healthy hook and in ADE as silence.
    for (const hook of matching) {
      try {
        await api.deleteWebhook(hook.id);
      } catch (error) {
        log("warn", `Could not remove the stale Linear webhook ${hook.id}: ${error?.message ?? error}`);
      }
    }

    const secret = randomBytes(32).toString("hex");
    let created;
    try {
      created = await api.createWebhook({
        url,
        secret,
        label: WEBHOOK_LABEL,
        resourceTypes: [...RESOURCE_TYPES],
        allPublicTeams: true,
      });
    } catch (error) {
      return { ok: false, message: error?.message ?? "Linear refused to create the webhook." };
    }

    try {
      // The SECRET first. A record naming a hook whose secret is not stored is
      // the one state that reads as registered and delivers nothing.
      await sdk.secrets.set(SECRET_NAME, secret);
      await writeRegistration({
        webhookId: created.id,
        url: created.url,
        registeredAt: new Date().toISOString(),
      });
    } catch (error) {
      await api.deleteWebhook(created.id).catch(() => {});
      return {
        ok: false,
        message: `Linear created the webhook but ADE could not store its signing secret: ${error?.message ?? error}`,
      };
    }

    return { ok: true, message: "Linear now sends issue events to ADE.", ...(await webhookStatus()) };
  }

  /**
   * Remove the webhook this plugin created, and forget its secret.
   *
   * The teardown half of the pair. A hook Linear has already dropped is not an
   * error: the record and the secret still have to go, or the tile keeps
   * claiming a registration that does not exist.
   */
  async function unregisterWebhook() {
    const registration = await readRegistration();
    if (registration?.webhookId) {
      try {
        await api.deleteWebhook(registration.webhookId);
      } catch (error) {
        log("warn", `Could not delete the Linear webhook ${registration.webhookId}: ${error?.message ?? error}`);
      }
    }
    await sdk.secrets.delete(SECRET_NAME).catch(() => {});
    await sdk.collections.delete(REGISTRATION_COLLECTION, REGISTRATION_KEY).catch(() => {});
    return { ok: true, message: "ADE no longer receives Linear events.", ...(await webhookStatus()) };
  }

  return { registerWebhook, unregisterWebhook, webhookStatus };
}

module.exports = {
  CHANNEL_ID,
  REGISTRATION_COLLECTION,
  REGISTRATION_KEY,
  RESOURCE_TYPES,
  SECRET_NAME,
  WEBHOOK_LABEL,
  createWebhookSetup,
  formatLastEvent,
  normalizeUrl,
};
