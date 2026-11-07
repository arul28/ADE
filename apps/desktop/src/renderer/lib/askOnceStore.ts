/**
 * One question at a time, answered through a promise.
 *
 * The tab-close confirms (Apple, Android, Mac Desktop) use this. The caller
 * is `closeTool`, a callback with no JSX of its own, so it asks through a
 * promise, and a host mounted once per Work page shows the question.
 *
 * A second ask while one is on screen does not replace the first. It
 * resolves at once with `busyAnswer`, because two dialogs cannot both be
 * answered. Each store sets the safe answer for "could not ask".
 */
export type AskOnceRequest<Question, Answer> = Question & {
  resolve: (answer: Answer) => void;
};

export type AskOnceStore<Question, Answer> = {
  ask: (question: Question) => Promise<Answer>;
  settle: (answer: Answer) => void;
  get: () => AskOnceRequest<Question, Answer> | null;
  subscribe: (listener: () => void) => () => void;
  /** Test seam: an unanswered question from one test must not reach the next. */
  reset: () => void;
};

export function createAskOnceStore<Question extends object, Answer>(busyAnswer: Answer): AskOnceStore<Question, Answer> {
  let pending: AskOnceRequest<Question, Answer> | null = null;
  let listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    ask(question) {
      if (pending) return Promise.resolve(busyAnswer);
      return new Promise<Answer>((resolve) => {
        pending = { ...question, resolve };
        emit();
      });
    },
    settle(answer) {
      const request = pending;
      pending = null;
      emit();
      request?.resolve(answer);
    },
    get: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reset() {
      pending = null;
      listeners = new Set();
    },
  };
}
