/**
 * The sentence a Mac Desktop failure should show a person.
 *
 * Two layers add machine-readable noise to every error that crosses the
 * daemon boundary, and neither is meant for a panel:
 *
 *   1. The service tags its errors `MAC_DESKTOP_NO_DISPLAY: …` so the CLI can
 *      look up a recovery hint from a flattened `message` string.
 *   2. Electron wraps anything thrown inside an IPC handler as
 *      `Error invoking remote method 'ade.localRuntime.callAction': Error: …`.
 *
 * Both are useful in a log and useless in a chip that is 180px wide, so this
 * is the one place that peels them off. Pure and string-in/string-out: the
 * renderer has no business deciding what a code means, only that the person
 * reading the panel should not have to.
 *
 * The third kind of noise is the lane id. Service messages name the lane to be
 * unambiguous in a transcript (`Lane <uuid> is not recording its desktop.`),
 * and a UUID is not something a person can act on. Callers that know the lane
 * pass its id here; the id becomes the lane's name when one is known and is
 * dropped (with the sentence tidied) otherwise.
 */

/** `MAC_DESKTOP_NO_DISPLAY: `, and the driver's lowercase `window_not_ready: `. */
const CODE_PREFIX = /^(?:MAC_DESKTOP_[A-Z0-9_]+|[a-z][a-z0-9_]*(?:_[a-z0-9_]+)+):\s*/;

/** Electron's IPC wrapper, however many `Error:` hops it stacked up. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_LABEL = /^(?:[A-Za-z]*Error):\s*/;

export type MacDesktopErrorTextOptions = {
  /** The lane the failure is about, when the caller knows it. */
  laneId?: string | null;
  /** The lane's own name, when the caller has one. */
  laneName?: string | null;
  /** The machine the lane's runtime lives on, when the caller knows it. */
  machineName?: string | null;
  /** That machine's ADE version, when the caller knows it. */
  machineVersion?: string | null;
};

/**
 * The one error that means "update ADE on that machine".
 *
 * A brain older than this app has no `mac_desktop` action domain, so every call
 * comes back as an RPC refusal whose message is `Domain 'mac_desktop' is
 * unavailable in this runtime.` — sometimes behind the remote client's own
 * `Remote ADE service method ade/actions/call failed (code -32602): ` prefix.
 * That sentence names an action domain, which is a fact about the protocol and
 * not about the screen the user just opened — so it becomes a sentence naming
 * the machine and the version, which is the one thing they can act on.
 */
const MAC_DESKTOP_MISSING_DOMAIN = /Domain ['"]mac_desktop['"] is unavailable in this runtime/i;

function macDesktopMissingDomainText(options?: MacDesktopErrorTextOptions): string {
  const machine = options?.machineName?.trim() || "That machine";
  const version = options?.machineVersion?.trim();
  return version
    ? `${machine} runs ADE ${version}, which has no Mac Desktop. Update ADE there.`
    : `${machine} runs an older ADE, which has no Mac Desktop. Update ADE there.`;
}

/**
 * Replaces a lane id with the lane's name, or drops it.
 *
 * `Lane <id> is not recording its desktop.` becomes
 * `Lane docs-fix is not recording its desktop.` when the name is known, and
 * `This lane is not recording its desktop.` when it is not — the leading
 * `Lane` the id leaves behind is what keeps the sentence a sentence. A bare id
 * elsewhere in the message is replaced by the name or removed.
 */
export function stripMacDesktopLaneId(
  text: string,
  laneId: string | null | undefined,
  laneName: string | null | undefined,
): string {
  const id = laneId?.trim();
  if (!id || !text.includes(id)) return text;
  const name = laneName?.trim() || null;
  let next = text.split(id).join(name ?? "");
  if (!name) {
    next = next
      .replace(/(^|[.!?]\s+)Lane\s+/g, "$1This lane ")
      .replace(/\bLane\s+(?=[.,;:!?]|$)/g, "This lane");
  }
  return next.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

export function macDesktopErrorText(
  raw: string | null | undefined,
  options?: MacDesktopErrorTextOptions,
): string | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text.length) return null;
  // Order matters: the wrapper sits outside the `Error:` labels, which sit
  // outside the service's own code prefix.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(IPC_WRAPPER, "").replace(ERROR_LABEL, "").replace(CODE_PREFIX, "").trim();
    if (text === before) break;
  }
  // A brain with no domain at all is the one failure the panel answers with the
  // machine's own name and version rather than with the refusal itself.
  if (MAC_DESKTOP_MISSING_DOMAIN.test(text)) return macDesktopMissingDomainText(options);
  if (options?.laneId) text = stripMacDesktopLaneId(text, options.laneId, options.laneName);
  return text.length ? text : null;
}
