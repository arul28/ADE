/** A maximal run plus the ignorable rows found between its members. */
export type ConsecutiveRun<Row, Member extends Row> = {
  members: Member[];
  skipped: Row[];
  /** Index immediately after the final member; trailing skipped rows are excluded. */
  nextIndex: number;
};

/**
 * Collect one consecutive run. Callers define row membership, rows that draw
 * nothing, and any run-specific boundary such as turn-end liveness or stop
 * attribution. A null result means fewer than two members were found.
 */
export function collectConsecutiveRun<Row, Member extends Row>(
  rows: readonly Row[],
  startIndex: number,
  options: {
    isMember: (row: Row) => row is Member;
    isIgnorable: (row: Row) => boolean;
    canJoin?: (first: Member, candidate: Member) => boolean;
  },
): ConsecutiveRun<Row, Member> | null {
  const first = rows[startIndex];
  if (!first || !options.isMember(first)) return null;

  const members: Member[] = [first];
  const skipped: Row[] = [];
  let pendingSkipped: Row[] = [];
  let end = startIndex + 1;
  while (end < rows.length) {
    const candidate = rows[end]!;
    if (options.isIgnorable(candidate)) {
      pendingSkipped.push(candidate);
      end += 1;
      continue;
    }
    if (!options.isMember(candidate) || (options.canJoin && !options.canJoin(first, candidate))) break;
    skipped.push(...pendingSkipped);
    pendingSkipped = [];
    members.push(candidate);
    end += 1;
  }

  if (members.length < 2) return null;
  return { members, skipped, nextIndex: end - pendingSkipped.length };
}

/** True when a prior grouped envelope still contains these exact row objects. */
export function sameRunMembers<Row>(
  previous: readonly Row[] | undefined,
  next: readonly Row[],
): boolean {
  if (!previous || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}
