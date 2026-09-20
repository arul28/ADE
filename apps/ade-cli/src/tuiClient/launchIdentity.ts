/**
 * The three selectors that decide *which brain* a session launches as:
 * the provider account (`instanceId`), the saved harness preset (`presetId`),
 * and the stored API credential (`credentialId`).
 *
 * They travel together everywhere in the TUI — model state, session summaries,
 * terminal sessions, and both launch calls — and every surface that reads them
 * off a session has to apply the same three-source fallback. Keeping that
 * fallback and the omit-when-unset spread in one module is what stops the
 * copies from drifting: a resume path that forgot one level of
 * `resumeMetadata` silently launches a chat under the wrong account.
 */

/** A fully resolved selection; `null` means "let the runtime pick its default". */
export type LaunchIdentity = {
  instanceId: string | null;
  presetId: string | null;
  credentialId: string | null;
};

type LaunchIdentityFields = {
  instanceId?: string | null;
  presetId?: string | null;
  credentialId?: string | null;
};

/**
 * Anything that may carry a launch identity: a session summary or terminal
 * session with the fields inline, with them on its resume metadata, or with
 * them on the resume metadata's recorded launch arguments.
 */
export type LaunchIdentitySource = LaunchIdentityFields & {
  resumeMetadata?: (LaunchIdentityFields & {
    launch?: LaunchIdentityFields | null;
  }) | null;
};

/**
 * Resolve one identity from a session-shaped source.
 *
 * Precedence is inline field → resume metadata → the launch arguments recorded
 * inside that metadata: the inline field is what the runtime believes right
 * now, and the two metadata levels are what the session was started with, in
 * order of how recently they were written.
 */
export function resolveLaunchIdentity(
  source: LaunchIdentitySource | null | undefined,
): LaunchIdentity {
  const pick = (key: keyof LaunchIdentityFields): string | null =>
    source?.[key]
    ?? source?.resumeMetadata?.[key]
    ?? source?.resumeMetadata?.launch?.[key]
    ?? null;
  return {
    instanceId: pick("instanceId"),
    presetId: pick("presetId"),
    credentialId: pick("credentialId"),
  };
}

/**
 * Spread form for building a payload: each selector is present only when it is
 * actually set, so an unset one leaves the runtime's own default rule alone
 * instead of sending a second, TUI-shaped way of saying "no selection".
 */
export function launchIdentityFields(identity: LaunchIdentity): {
  instanceId?: string;
  presetId?: string;
  credentialId?: string;
} {
  return {
    ...(identity.instanceId ? { instanceId: identity.instanceId } : {}),
    ...(identity.presetId ? { presetId: identity.presetId } : {}),
    ...(identity.credentialId ? { credentialId: identity.credentialId } : {}),
  };
}

/** True when two identities name the same brain. */
export function sameLaunchIdentity(left: LaunchIdentity, right: LaunchIdentity): boolean {
  return left.instanceId === right.instanceId
    && left.presetId === right.presetId
    && left.credentialId === right.credentialId;
}
