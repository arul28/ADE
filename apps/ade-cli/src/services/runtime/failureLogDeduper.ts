export type FailureLogDeduper = {
  note: (signature: string, message: string) => void;
  clear: (signature: string) => void;
};

type FailureLogState = {
  occurrences: number;
  lastSummaryAt: number;
  message: string;
};

export function createFailureLogDeduper(options: {
  log: (message: string) => void;
  now?: () => number;
  summaryIntervalMs?: number;
}): FailureLogDeduper {
  const now = options.now ?? Date.now;
  const summaryIntervalMs = options.summaryIntervalMs ?? 60_000;
  const failures = new Map<string, FailureLogState>();
  return {
    note(signature, message) {
      const at = now();
      const existing = failures.get(signature);
      if (!existing) {
        failures.set(signature, { occurrences: 1, lastSummaryAt: at, message });
        options.log(message);
        return;
      }
      existing.occurrences += 1;
      existing.message = message;
      if (at - existing.lastSummaryAt >= summaryIntervalMs) {
        options.log(`ADE brain sync host still failing (${existing.occurrences} occurrences): ${message}`);
        existing.lastSummaryAt = at;
      }
    },
    clear(signature) {
      failures.delete(signature);
    },
  };
}
