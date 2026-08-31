import fs from "node:fs";

import { builtinSurfaceOwnerForPlugin } from "../../../shared/plugins/builtinSurfaces";
import { joinSurfaceNames } from "../../../shared/plugins/installDisclosure";
import type { PluginBuiltinSurfaceId, PluginManifest } from "../../../shared/plugins/manifest";
import { isRecord } from "../../../shared/plugins/parse";
import {
  assertPluginSecretName,
  PluginSdkError,
  type PluginCredentialHandoffResult,
} from "../../../shared/plugins/sdk";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import type { Logger } from "../logging/logger";
import { writeTextAtomic } from "../shared/utils";
import type { PluginSecretStore } from "./pluginSecretStore";

/**
 * Handing an official plugin the credential ADE already holds for the built-in
 * it supersedes — once, and only after the user has read what moves.
 *
 * This is the release-day seam. `ade-linear` replaces ADE's compiled Linear
 * integration, and every existing user already has a working Linear token in
 * ADE's own machine credential store. Without this module the day the plugin
 * ships is the day all of them reconnect, and "the upgrade signed me out of
 * everything" is the kind of release nobody forgives.
 *
 * Three properties hold the design up:
 *
 * 1. **The user decides, and is told exactly what they are deciding.** The card
 *    names every field that moves, in a person's words, and names what is
 *    deliberately held back. None of that copy comes from the plugin: it is
 *    derived from the descriptor table below and from the manifest the HOST
 *    parsed, exactly the way `installDisclosure.ts` is derived and never quoted.
 * 2. **Asked once.** An answer — yes or no — is recorded, and a second
 *    `request` returns it without raising a second card. A plugin that could
 *    re-prompt on every start would turn a consent card into a nag until the
 *    user clicked yes to make it stop, which is not consent.
 * 3. **Values never leave the two stores.** A credential read here goes into
 *    the plugin secret store and nowhere else — not into a log line, not into
 *    the state file, not into the returned result. `secretNames` is keys only.
 */

/** One stored value that moves, and the words the reader sees for it. */
export type BuiltinCredentialField = {
  /** The key in ADE's own machine credential store. */
  storeKey: string;
  /**
   * The name the plugin reads it back under, in its own secret namespace.
   *
   * Must satisfy `PLUGIN_SECRET_NAME_PATTERN` — the plugin secret store refuses
   * anything else — which is why `everyDescriptorSecretNameIsStorable` in the
   * test file asserts it for the whole table rather than leaving a future
   * descriptor to discover it at handoff time, in front of a user.
   */
  secretName: string;
  /** What this value IS, in the words of someone reading the card. */
  describe: string;
  /**
   * Pull one field out of a stored JSON blob instead of handing over the blob.
   *
   * Absent for the ordinary case, where the stored string IS the credential.
   * Present where ADE stores several facts together and only some of them are
   * the user's to give away — see the OAuth client entry below, which is the
   * whole reason this hook exists.
   */
  select?: (stored: string) => string | null;
  /**
   * Without this field there is no connection to hand over at all.
   *
   * ADE's Linear keys are five FLAT entries rather than one blob, and the
   * non-token ones outlive a disconnect: an `authMode` left behind by a
   * connection the user removed is not a credential, and raising a card that
   * offers to hand over "your Linear connection" when there is no token would
   * be asking about something that does not exist.
   */
  anchor?: boolean;
};

export type BuiltinCredentialDescriptor = {
  builtin: PluginBuiltinSurfaceId;
  /** "your Linear connection" — the card's subject, in the user's words. */
  label: string;
  fields: BuiltinCredentialField[];
  /** Fields deliberately NOT handed over, and why — printed on the card. */
  withheld: string[];
};

/**
 * ADE's Linear credential, as it actually sits in the machine store: five flat
 * keys written by `cto/linearCredentialService.ts`, not one blob.
 *
 * ## Why the client SECRET is withheld, and the client ID is not
 *
 * The OAuth client secret is ADE's own identity to Linear. It is not the user's
 * credential and it is not theirs to give: a plugin holding it could present
 * itself to Linear AS ADE, mint tokens in ADE's name, and do it on every machine
 * the plugin is installed on. There is no consent card that makes that a
 * reasonable thing to copy, so it is not in `fields` at all — not gated, not
 * optional, absent.
 *
 * The client ID is handed over because a refresh token is only ever redeemable
 * by the client it was issued to. Without the id the refresh token is dead
 * weight: the plugin would inherit a connection it could not renew, which is
 * exactly the reconnect this whole module exists to avoid. And giving it away
 * costs nothing, because ADE's bundled client is a public PKCE client that ships
 * no secret at all (`ADE_LINEAR_APP_CLIENT_ID`, linearCredentialService.ts:22-23)
 * — the id is already visible in the authorize URL of every sign-in ADE has ever
 * run, so a plugin that wanted it could read it off one.
 *
 * If the user configured their OWN confidential OAuth client, the plugin gets
 * that client's id and no secret. Its refresh will fail the way any client
 * missing its secret fails, and the plugin falls back to its ordinary sign-in —
 * a re-authorization, which is the correct outcome. ADE does not hand a plugin
 * the ability to act as a client it does not own.
 */
const LINEAR_CREDENTIAL_DESCRIPTOR: BuiltinCredentialDescriptor = {
  builtin: "linear",
  label: "your Linear connection",
  fields: [
    {
      storeKey: "linear.token.v1",
      secretName: "LINEAR_ACCESS_TOKEN",
      describe: "Your Linear access token",
      anchor: true,
    },
    {
      storeKey: "linear.refreshToken.v1",
      secretName: "LINEAR_REFRESH_TOKEN",
      describe: "The refresh token that keeps it working",
    },
    {
      storeKey: "linear.tokenExpiresAt.v1",
      secretName: "LINEAR_TOKEN_EXPIRES_AT",
      describe: "When the access token expires",
    },
    {
      storeKey: "linear.authMode.v1",
      secretName: "LINEAR_AUTH_MODE",
      describe: "Whether you signed in with Linear or pasted an API key",
    },
    {
      storeKey: "linear.oauthClient.v1",
      secretName: "LINEAR_OAUTH_CLIENT_ID",
      describe: "The public OAuth client id the token was issued to",
      // The `clientSecret` sibling sits in this same stored object and is never
      // read out of it. See the block comment above: it is ADE's identity, not
      // the user's credential.
      select: (stored) => {
        try {
          const parsed: unknown = JSON.parse(stored);
          if (!isRecord(parsed)) return null;
          const clientId = typeof parsed.clientId === "string" ? parsed.clientId.trim() : "";
          return clientId.length > 0 ? clientId : null;
        } catch {
          return null;
        }
      },
    },
  ],
  withheld: [
    "ADE's own OAuth client secret, which is ADE's identity to Linear rather than yours",
  ],
};

/**
 * Every built-in whose credential can be inherited, keyed by surface id.
 *
 * Partial rather than total: most gateable surfaces hold no credential of their
 * own — the Graph is a view over state other things own — and a table that
 * forced an entry for each would invite an empty descriptor that raises a card
 * about nothing. Adding the next superseded integration is one literal here and
 * no change anywhere else in this file.
 */
export const BUILTIN_CREDENTIAL_DESCRIPTORS: Readonly<
  Partial<Record<PluginBuiltinSurfaceId, BuiltinCredentialDescriptor>>
> = {
  linear: LINEAR_CREDENTIAL_DESCRIPTOR,
};

export function builtinCredentialDescriptor(
  builtin: PluginBuiltinSurfaceId,
): BuiltinCredentialDescriptor | null {
  return BUILTIN_CREDENTIAL_DESCRIPTORS[builtin] ?? null;
}

/* ── Card copy ──────────────────────────────────────────────────────────────
 *
 * Pure and derived, like `installDisclosure.ts`. Every word comes from the
 * descriptor above or from the manifest the host parsed off disk; nothing a
 * plugin passed at call time reaches the card, because a plugin that could
 * write the sentence could write a different one from the transfer it is
 * actually asking for.
 * ------------------------------------------------------------------------- */

/**
 * How to name the plugin in a sentence that also names the third party.
 *
 * `ade-linear`'s display name is "Linear" and its subject is "your Linear
 * connection", so the obvious template produces "Give Linear your Linear
 * connection?" — a sentence whose two halves look like a typo. Saying "the
 * Linear plugin" separates the package from the service it connects to, and is
 * only reached when the two names really do collide: a plugin called something
 * else keeps its own name in the ordinary form.
 */
function handoffSubject(displayName: string, label: string): string {
  const name = displayName.trim();
  if (!name) return "this plugin";
  return label.toLowerCase().includes(name.toLowerCase()) ? `the ${name} plugin` : name;
}

export function buildCredentialHandoffTitle(args: { displayName: string; label: string }): string {
  return `Give ${handoffSubject(args.displayName, args.label)} ${args.label}?`;
}

export function buildCredentialHandoffBody(args: {
  displayName: string;
  descriptor: BuiltinCredentialDescriptor;
}): string {
  const { descriptor } = args;
  const subject = handoffSubject(args.displayName, descriptor.label);
  const lines: string[] = [];
  lines.push(
    `ADE already holds ${descriptor.label}. Handing it over means ${subject} works straight`
    + " away, with no second sign-in.",
  );
  lines.push("");
  lines.push(`Copies into ${subject}'s own secret store:`);
  for (const field of descriptor.fields) lines.push(`- ${field.describe}`);
  if (descriptor.withheld.length > 0) {
    lines.push("");
    // Named on the card rather than left to the reader's trust. The one thing
    // held back is the one thing a reader would most want to know is held back.
    lines.push(`Does not copy: ${joinSurfaceNames(descriptor.withheld)}.`);
  }
  lines.push("");
  lines.push(
    "If you say yes, these are copied once and ADE keeps its own copy — nothing is taken away"
    + " from ADE.",
  );
  lines.push(`If you say no, nothing is copied and ${subject} will ask you to sign in.`);
  return lines.join("\n");
}

/* ── Recorded answers ───────────────────────────────────────────────────── */

/**
 * What the user said, per (plugin, built-in). Deliberately the smallest thing
 * that can be recorded: a status and when.
 *
 * A credential VALUE never appears here, and this file is plain JSON beside the
 * install registry rather than in the credential store precisely so that stays
 * obviously true — there is nothing in this file worth reading.
 */
type HandoffAnswer = { status: "accepted" | "declined"; at: string };

type HandoffState = Record<string, HandoffAnswer>;

function answerKey(pluginId: string, builtin: PluginBuiltinSurfaceId): string {
  return `${pluginId}:${builtin}`;
}

/**
 * Lenient by design: a file that will not parse is treated as no answers.
 *
 * The failure this avoids is a plugin permanently unable to ask because a
 * truncated write left one byte of garbage. Losing the record costs one extra
 * card; refusing to read it costs the user their connection with no way back.
 */
function readState(statePath: string): HandoffState {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return {};
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(decoded)) return {};
  const state: HandoffState = {};
  for (const [key, value] of Object.entries(decoded)) {
    if (!isRecord(value)) continue;
    if (value.status !== "accepted" && value.status !== "declined") continue;
    state[key] = {
      status: value.status,
      at: typeof value.at === "string" ? value.at : "",
    };
  }
  return state;
}

export type PluginCredentialHandoffService = {
  /**
   * Offer this plugin the credential ADE holds for `builtin`, asking the user
   * once.
   *
   * Rejects with `not_permitted` when the manifest did not declare the built-in
   * or when this plugin does not own it, and with `auth_unavailable` when there
   * is a credential to offer and nothing on this machine that can ask a person
   * about it. A DECLINE is not an error and never throws.
   */
  request(args: {
    pluginId: string;
    manifest: PluginManifest;
    builtin: PluginBuiltinSurfaceId;
  }): Promise<PluginCredentialHandoffResult>;
  /**
   * Drop this plugin's recorded answers, for uninstall.
   *
   * Without it a reinstall would inherit an answer given to a package that is
   * no longer on the machine: a "declined" that can never be revisited, or —
   * worse — an "accepted" that silently suppresses the card for whatever gets
   * installed under that id next.
   */
  forget(pluginId: string): void;
};

export function createPluginCredentialHandoffService(deps: {
  logger: Logger;
  credentials: SyncCredentialStore;
  secrets: PluginSecretStore;
  statePath: string;
  /**
   * Put the card in front of the user and answer with what they said.
   *
   * Optional, and its absence is a REFUSAL rather than a default. A headless
   * brain with no desktop attached and no phone paired has nobody to ask, and
   * the two ways of pretending otherwise are both worse than saying so: hanging
   * leaves the plugin waiting on an answer that will never come, and quietly
   * copying would move a credential nobody agreed to move. Same shape as
   * `captureAudioClip` and `postNotification` on the SDK server — see
   * `pluginSdkServer.ts` — down to the typed code the plugin can act on.
   */
  requestConsent?: (args: {
    pluginId: string;
    displayName: string;
    builtin: PluginBuiltinSurfaceId;
    title: string;
    body: string;
  }) => Promise<boolean>;
  now?: () => number;
}): PluginCredentialHandoffService {
  const now = deps.now ?? (() => Date.now());
  /**
   * Cards live for as long as a person takes to read one, and a plugin that
   * retries — its own RPC deadline expired, its child restarted — must join the
   * card already in front of the user rather than stack a second one on top of
   * it. Mirrors `pendingInstallCards` in `pluginInstallApproval.ts`.
   */
  const pendingCards = new Map<string, Promise<PluginCredentialHandoffResult>>();

  const persist = (state: HandoffState): void => {
    // 0o600 for the same reason the rest of `~/.ade` is: not for correctness —
    // nothing here is a secret — but so the file follows the directory's
    // convention on the platforms that have one. Windows ignores the mode and
    // the atomic rename below is what matters there.
    writeTextAtomic(deps.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  };

  const record = (
    pluginId: string,
    builtin: PluginBuiltinSurfaceId,
    status: "accepted" | "declined",
  ): void => {
    const state = readState(deps.statePath);
    state[answerKey(pluginId, builtin)] = { status, at: new Date(now()).toISOString() };
    persist(state);
  };

  /**
   * Read every field the descriptor names, dropping the ones ADE does not hold.
   *
   * Values live in this array and in the plugin secret store, and nowhere else.
   * The array is local to one call and the caller only ever reads `.secretName`
   * off it afterwards.
   */
  const readFields = async (
    descriptor: BuiltinCredentialDescriptor,
  ): Promise<{ field: BuiltinCredentialField; value: string }[]> => {
    const present: { field: BuiltinCredentialField; value: string }[] = [];
    for (const field of descriptor.fields) {
      const stored = await deps.credentials.get(field.storeKey);
      if (typeof stored !== "string" || stored.trim().length === 0) continue;
      const value = field.select ? field.select(stored) : stored.trim();
      if (!value) continue;
      present.push({ field, value });
    }
    return present;
  };

  /**
   * Has the plugin lost the copy a recorded accept gave it?
   *
   * Asked of the ANCHOR field only. The anchor is the one field without which
   * there is no connection — the access token — and the others are things that
   * describe it. A plugin holding the token and nothing else is connected; one
   * holding an expiry and no token is not, whatever the record says.
   *
   * A store this host cannot read answers "not gone", deliberately: an
   * unreadable secret store is not evidence that a copy was deleted, and
   * treating it as such would raise a consent card every time the credential
   * store hiccuped.
   */
  const handedCopyIsGone = async (
    pluginId: string,
    descriptor: BuiltinCredentialDescriptor,
  ): Promise<boolean> => {
    const anchor = descriptor.fields.find((field) => field.anchor);
    if (!anchor) return false;
    try {
      const held = await deps.secrets.get(pluginId, anchor.secretName);
      return typeof held !== "string" || held.trim().length === 0;
    } catch {
      return false;
    }
  };

  const runRequest = async (args: {
    pluginId: string;
    manifest: PluginManifest;
    builtin: PluginBuiltinSurfaceId;
  }): Promise<PluginCredentialHandoffResult> => {
    const { pluginId, manifest, builtin } = args;

    if (!(manifest.credentialHandoff ?? []).includes(builtin)) {
      throw new PluginSdkError(
        "not_permitted",
        `${pluginId} does not declare "${builtin}" in its manifest's credentialHandoff.`,
      );
    }
    // The check the manifest parser deliberately could NOT do. `parseCredentialHandoff`
    // is pure and cannot import the owner table (`builtinSurfaces.ts` imports
    // `manifest.ts`, so the dependency only runs one way), which means an
    // official manifest can name any built-in in the closed list. Ownership is
    // what stops `ade-graph` from asking for the Linear token by declaring it.
    const owner = builtinSurfaceOwnerForPlugin(pluginId);
    if (!owner || owner.builtinId !== builtin) {
      throw new PluginSdkError(
        "not_permitted",
        `${pluginId} is not the owner of the built-in "${builtin}", so it cannot inherit its credential.`,
      );
    }

    const descriptor = builtinCredentialDescriptor(builtin);
    // An owned, declared built-in ADE holds no credential for — the Graph, say.
    // Indistinguishable from "the user is not connected" to the plugin, and it
    // should be: both mean there is nothing here to inherit.
    if (!descriptor) return { builtin, status: "empty", secretNames: [] };

    const recorded = readState(deps.statePath)[answerKey(pluginId, builtin)];
    if (recorded && !(recorded.status === "accepted" && await handedCopyIsGone(pluginId, descriptor))) {
      // Once. A second ask is how a consent card becomes a nag, and a nag is
      // answered yes to make it stop.
      //
      // The one exception is above: a recorded ACCEPT is only worth honouring
      // while the copy it produced still exists. A plugin that deleted its own
      // secrets — a disconnect button, a reset, a bug — is a plugin the user
      // must be able to reconnect, and a record saying "already answered" with
      // an empty secret store is a dead end they cannot get out of. A recorded
      // DECLINE never re-asks whatever the store holds: nothing was copied, so
      // there is no copy whose absence could mean anything.
      return {
        builtin,
        status: recorded.status,
        secretNames: descriptor.fields.map((field) => field.secretName),
      };
    }

    const present = await readFields(descriptor);
    const secretNames = present.map((entry) => entry.field.secretName);
    if (!present.some((entry) => entry.field.anchor)) {
      // Nothing recorded: there was no question. A user who connects Linear
      // tomorrow should get the card then, not be told they already answered a
      // question nobody asked.
      deps.logger.info("plugin_credential_handoff.empty", { pluginId, builtin });
      return { builtin, status: "empty", secretNames: [] };
    }

    // Checked here rather than at the top so a machine with nothing to hand
    // over still answers `empty` honestly instead of blaming a missing client
    // for a credential that does not exist.
    const requestConsent = deps.requestConsent;
    if (!requestConsent) {
      throw new PluginSdkError(
        "auth_unavailable",
        `Nothing on this machine can ask about ${descriptor.label}. Try again from a device that can show the request.`,
      );
    }

    const displayName = manifest.displayName || manifest.name;
    const title = buildCredentialHandoffTitle({ displayName, label: descriptor.label });
    const body = buildCredentialHandoffBody({ displayName, descriptor });
    const agreed = await requestConsent({ pluginId, displayName, builtin, title, body });
    if (!agreed) {
      // A decline is an ANSWER, not a failure. Recorded so it is not asked
      // again, and returned rather than thrown so a plugin that offered to
      // inherit a connection can simply show its own sign-in.
      record(pluginId, builtin, "declined");
      deps.logger.info("plugin_credential_handoff.declined", { pluginId, builtin });
      return { builtin, status: "declined", secretNames };
    }

    for (const entry of present) {
      await deps.secrets.set(pluginId, assertPluginSecretName(entry.field.secretName), entry.value);
    }
    // Recorded AFTER the writes: a crash between them leaves the plugin with
    // secrets and no record, so the next request asks again and rewrites the
    // same values. The reverse order would leave a plugin permanently recorded
    // as connected with an empty secret store and no way to ask again.
    record(pluginId, builtin, "accepted");
    // Names only, forever. `secretNames` is what the plugin reads back with and
    // is safe to log; a value from `present` must never join it here.
    deps.logger.info("plugin_credential_handoff.accepted", { pluginId, builtin, secretNames });
    return { builtin, status: "accepted", secretNames };
  };

  return {
    request(args) {
      const key = answerKey(args.pluginId, args.builtin);
      const standing = pendingCards.get(key);
      if (standing) return standing;
      const running = runRequest(args).finally(() => {
        if (pendingCards.get(key) === running) pendingCards.delete(key);
      });
      pendingCards.set(key, running);
      return running;
    },
    forget(pluginId) {
      const state = readState(deps.statePath);
      const prefix = `${pluginId}:`;
      let changed = false;
      for (const key of Object.keys(state)) {
        if (!key.startsWith(prefix)) continue;
        delete state[key];
        changed = true;
      }
      if (!changed) return;
      persist(state);
      deps.logger.info("plugin_credential_handoff.forgotten", { pluginId });
    },
  };
}
