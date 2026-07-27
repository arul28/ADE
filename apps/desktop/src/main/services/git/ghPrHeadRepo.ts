/**
 * Head-repository filtering for `gh pr list --head <branch>`.
 *
 * `gh pr list --head` matches on branch NAME only, so a pull request opened
 * from a fork that happens to use the same branch name will be returned and
 * attach itself to the lane. Requesting the head-repository fields lets us
 * drop those.
 *
 * Compatibility: `headRepositoryOwner` / `headRepository` are only emitted by
 * `gh >= 2.47`. Older CLIs omit them entirely, so parsing MUST be lenient and
 * an absent field MUST mean "cannot verify — accept" rather than "reject";
 * a strict decode would silently drop every PR for anyone on an older gh.
 */

/** JSON field set requested from `gh pr list`. */
export const GH_PR_LIST_JSON_FIELDS =
  "url,number,title,headRefName,headRepositoryOwner,headRepository";

/**
 * Fallback field set for a `gh` too old to expose the head-repo fields on
 * `pr list`. `gh` rejects an unknown --json field with a non-zero exit rather
 * than omitting it, so requesting the newer fields against an old CLI fails the
 * entire lookup. These four have been present for as long as `pr list --json`
 * has existed; a result decoded from them carries no owner, which
 * `ghPrHeadRepoMatchesLane` treats as unverifiable-accept.
 */
export const GH_PR_LIST_LEGACY_JSON_FIELDS = "url,number,title,headRefName";

export type GhPrListEntry = {
  url: string | null;
  number: number | null;
  title: string | null;
  headRefName: string | null;
  /** `null` when gh did not report it (older gh, or a deleted fork). */
  headRepositoryOwner: string | null;
  /** `null` when gh did not report it (older gh, or a deleted fork). */
  headRepositoryName: string | null;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * gh renders these as objects (`{"id":"...","login":"acme"}` /
 * `{"id":"...","name":"widgets"}`). Accept a bare string too so a future
 * shape change degrades to "unverifiable" instead of a hard failure.
 */
function readNamedNode(value: unknown, keys: readonly string[]): string | null {
  const direct = readString(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = readString(record[key]);
    if (candidate) return candidate;
  }
  return null;
}

/** Lenient decode of one `gh pr list --json ...` array element. */
export function parseGhPrListEntry(raw: unknown): GhPrListEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    url: readString(record.url),
    number: typeof record.number === "number" && Number.isFinite(record.number)
      ? record.number
      : null,
    title: readString(record.title),
    headRefName: readString(record.headRefName),
    headRepositoryOwner: readNamedNode(record.headRepositoryOwner, ["login", "name"]),
    headRepositoryName: readNamedNode(record.headRepository, ["name", "nameWithOwner"]),
  };
}

/**
 * True when the PR's head repository is (or cannot be proven not to be) the
 * lane's own remote.
 *
 * Accepts when either side is unknown — an older gh omits the field, and a
 * lane whose origin is not a parseable GitHub remote has nothing to compare
 * against. Only a confirmed owner mismatch rejects.
 */
export function ghPrHeadRepoMatchesLane(args: {
  entry: Pick<GhPrListEntry, "headRepositoryOwner">;
  expectedOwner: string | null | undefined;
}): boolean {
  const expected = (args.expectedOwner ?? "").trim();
  const actual = (args.entry.headRepositoryOwner ?? "").trim();
  if (!expected || !actual) return true;
  return expected.toLowerCase() === actual.toLowerCase();
}

export type GhOpenPrSummary = {
  prUrl: string | null;
  prNumber: number | null;
  title: string | null;
  headRefName: string | null;
};

export const EMPTY_GH_OPEN_PR_SUMMARY: GhOpenPrSummary = {
  prUrl: null,
  prNumber: null,
  title: null,
  headRefName: null,
};

/**
 * Pick the first PR in a `gh pr list` payload whose head repository belongs to
 * the lane's own remote owner.
 *
 * We deliberately ask gh for more than one row: `--head` matches by branch name
 * across forks, so a fork PR can sort ahead of ours and `--limit 1` would leave
 * nothing to fall back to once it is filtered out.
 */
export function selectOwnRepoOpenPr(args: {
  rawJson: string;
  expectedOwner: string | null | undefined;
}): GhOpenPrSummary {
  const raw = args.rawJson.trim();
  if (!raw) return { ...EMPTY_GH_OPEN_PR_SUMMARY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_GH_OPEN_PR_SUMMARY };
  }
  if (!Array.isArray(parsed)) return { ...EMPTY_GH_OPEN_PR_SUMMARY };
  for (const item of parsed) {
    const entry = parseGhPrListEntry(item);
    if (!entry) continue;
    if (!ghPrHeadRepoMatchesLane({ entry, expectedOwner: args.expectedOwner })) continue;
    return {
      prUrl: entry.url,
      prNumber: entry.number,
      title: entry.title,
      headRefName: entry.headRefName,
    };
  }
  return { ...EMPTY_GH_OPEN_PR_SUMMARY };
}
