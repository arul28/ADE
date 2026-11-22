/** How long one step of a multi-step operation took. */
export type PhaseTiming<P extends string> = { phase: P; ms: number };

export type PhaseClock<P extends string> = {
  /** Close the current step and start `phase`. Entering the current step again does nothing. */
  enter(phase: P): void;
  current(): P;
  /** Every step so far, the current one up to now. */
  timings(): PhaseTiming<P>[];
  totalMs(): number;
  /** `step:ms step:ms`, for a log line. */
  summary(): string;
};

/** Times the steps of one operation, starting in `initial` now. */
export function createPhaseClock<P extends string>(initial: P): PhaseClock<P> {
  const startedAt = Date.now();
  const closed: PhaseTiming<P>[] = [];
  let current = initial;
  let currentStartedAt = startedAt;
  const timings = (): PhaseTiming<P>[] => [
    ...closed,
    { phase: current, ms: Math.max(0, Date.now() - currentStartedAt) },
  ];
  return {
    enter(phase) {
      if (phase === current) return;
      const now = Date.now();
      closed.push({ phase: current, ms: Math.max(0, now - currentStartedAt) });
      current = phase;
      currentStartedAt = now;
    },
    current: () => current,
    timings,
    totalMs: () => Date.now() - startedAt,
    summary: () => timings().map(({ phase, ms }) => `${phase}:${ms}`).join(" "),
  };
}
