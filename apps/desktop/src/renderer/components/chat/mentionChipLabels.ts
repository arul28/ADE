// Display labels for `@pr:`, `@mac:` and `@person:` chips in SENT messages.
//
// A sent message keeps only the token (`@pr:<ADE row id>`), so without help
// the transcript can only print "PR 3f2a1b9c". Labels come from data the
// renderer already reads, cheapest first:
//   1. labels remembered from @-menu suggestions this session (free);
//   2. PRs: the chat machine's PR list (`listPrsCoalesced`, one coalesced
//      read), which also yields the number/repo a click needs;
//   3. machines: one account directory read per app session, only when a
//      machine chip has no remembered label;
//   4. Linear people: an exact lookup of the chips' ids on the chat's
//      machine, batched per pin, only when a chip has no remembered label (a
//      GitHub chip already shows its login). A miss is asked again after a
//      minute, not remembered as "nobody".
// Unknown stays the chip's short-id label; nothing here throws.

import { useEffect, useMemo, useState } from "react";

import { formatChatMentionToken, parsePersonMentionId } from "../../../shared/chatMentions";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { findMachineByMentionId } from "../../../shared/accountMachineSnapshot";
import type { Chip } from "../../../shared/chips";
import type { DeeplinkPrTarget } from "../../../shared/deeplinks";
import type { OpenProjectBinding, PrSummary } from "../../../shared/types";
import type { ChatMentionSuggestion } from "../../../shared/types/chatMentions";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { fetchAccountMachines } from "../../lib/account";

const rememberedLabels = new Map<string, string>();
const MAX_REMEMBERED = 500;

/** Keep PR and machine labels from @-menu results for later transcript chips. */
export function rememberMentionSuggestionLabels(suggestions: readonly ChatMentionSuggestion[]): void {
  for (const suggestion of suggestions) {
    if (suggestion.kind !== "pr" && suggestion.kind !== "machine" && suggestion.kind !== "mcp" && suggestion.kind !== "person") continue;
    const token = formatChatMentionToken(suggestion.kind, suggestion.id);
    rememberedLabels.delete(token);
    rememberedLabels.set(token, suggestion.title);
  }
  while (rememberedLabels.size > MAX_REMEMBERED) {
    const oldest = rememberedLabels.keys().next().value;
    if (oldest === undefined) break;
    rememberedLabels.delete(oldest);
  }
}

export type MentionChipResolution = {
  label: string | null;
  /** Where a PR chip click goes, once the PR row is known. */
  prTarget: DeeplinkPrTarget | null;
};

const NONE: MentionChipResolution = { label: null, prTarget: null };

/** How long a person id that did not resolve waits before it is asked again. */
const PERSON_LABEL_RETRY_MS = 60_000;
/** How long chips that render together wait to share one lookup. */
const PERSON_LABEL_BATCH_MS = 30;

const personLabelMissedAt = new Map<string, number>();
/** The lookup being gathered for each chat machine: chips that render together share it. */
const personLabelBatches = new Map<string, { ids: Set<string>; done: Promise<void> }>();

/** Look up person ids on the chat's machine by exact id; results land in `rememberedLabels`. */
function lookupPersonLabel(pin: OpenProjectBinding, id: string): Promise<void> {
  const pending = personLabelBatches.get(pin.key);
  if (pending) {
    pending.ids.add(id);
    return pending.done;
  }
  const ids = new Set([id]);
  const done = new Promise<void>((resolve) => setTimeout(resolve, PERSON_LABEL_BATCH_MS))
    .then(() => {
      personLabelBatches.delete(pin.key);
      return window.ade?.agentChat?.listMentionSuggestions?.({ query: "people", ids: [...ids] }, pin);
    })
    .then((result) => rememberMentionSuggestionLabels(result?.suggestions ?? []))
    .catch(() => undefined);
  personLabelBatches.set(pin.key, { ids, done });
  return done;
}

function prResolution(pr: PrSummary): MentionChipResolution {
  return {
    label: `#${pr.githubPrNumber} ${pr.title?.trim() || "Untitled pull request"}`,
    prTarget: {
      kind: "pr",
      prNumber: pr.githubPrNumber,
      ...(pr.repoOwner && pr.repoName ? { repoOwner: pr.repoOwner, repoName: pr.repoName } : {}),
    },
  };
}

/** Label (and PR click target) for a `@pr:` / `@mac:` chip; `NONE` for any other chip. */
export function useMentionChipResolution(
  chip: Chip,
  scope: { pin: OpenProjectBinding | null; rootPath: string | null; machineRests?: boolean },
): MentionChipResolution {
  const source = chip.source;
  const mention = source.origin === "mention"
    && (source.mentionKind === "pr" || source.mentionKind === "machine" || source.mentionKind === "mcp" || source.mentionKind === "person")
    ? { kind: source.mentionKind, id: source.id }
    : null;
  const remembered = mention ? rememberedLabels.get(chip.token) ?? null : null;
  const [resolved, setResolved] = useState<MentionChipResolution>(NONE);
  const pinKey = scope.pin?.key ?? null;

  useEffect(() => {
    if (!mention) return;
    // A remembered machine label is all a machine chip needs; a PR chip still
    // reads its row so a click knows the number and repo.
    if ((mention.kind === "machine" || mention.kind === "mcp" || mention.kind === "person") && remembered) return;
    let cancelled = false;
    const load = mention.kind === "pr"
      ? listPrsCoalesced({ pin: scope.pin, projectRoot: scope.rootPath })
        .then((prs) => {
          const pr = prs.find((entry) => entry.id === mention.id);
          return pr ? prResolution(pr) : NONE;
        })
      : mention.kind === "mcp" ? Promise.resolve(NONE)
      : mention.kind === "person"
        // A resting ADE Cloud computer is never woken for a label.
        ? (parsePersonMentionId(mention.id)?.source === "linear" && scope.pin && !scope.machineRests
          && Date.now() - (personLabelMissedAt.get(chip.token) ?? 0) >= PERSON_LABEL_RETRY_MS
          ? lookupPersonLabel(scope.pin, mention.id).then((): MentionChipResolution => {
              const label = rememberedLabels.get(chip.token) ?? null;
              if (!label) personLabelMissedAt.set(chip.token, Date.now());
              return label ? { label, prTarget: null } : NONE;
            })
          : Promise.resolve(NONE))
      : fetchAccountMachines().then((result) => {
          const machine = result.state === "ok" ? findMachineByMentionId(result.machines, mention.id) : null;
          const name = machine ? accountMachineDisplayName(machine) : null;
          return name ? { label: name, prTarget: null } : NONE;
        });
    void load.catch(() => NONE).then((next) => {
      if (!cancelled) setResolved(next);
    });
    return () => {
      cancelled = true;
    };
    // `mention` is derived from the memoized chip; key on its identity fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.kind, mention?.id, remembered, pinKey, scope.rootPath, scope.machineRests]);

  const isMention = mention !== null;
  return useMemo(
    () => (isMention ? { label: resolved.label ?? remembered, prTarget: resolved.prTarget } : NONE),
    [isMention, resolved, remembered],
  );
}
