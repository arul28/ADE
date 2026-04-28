// Tiny pub/sub used by the tour engine to drive dialogs by stable id. Dialog
// components subscribe by id (e.g. "lanes.create") and react to open/close
// events; a separate `subscribeAll` channel lets devtools or debug surfaces
// observe every event.

export type DialogBusEvent =
  | { type: "open"; id: string; props?: Record<string, unknown> }
  | { type: "close"; id: string };

export type DialogBusCallback = (event: DialogBusEvent) => void;

export type DialogBus = {
  open: (id: string, props?: Record<string, unknown>) => void;
  close: (id: string) => void;
  subscribe: (id: string, cb: DialogBusCallback) => () => void;
  subscribeAll: (cb: DialogBusCallback) => () => void;
};

export function createDialogBus(): DialogBus {
  const perId = new Map<string, Set<DialogBusCallback>>();
  const all = new Set<DialogBusCallback>();

  function emit(event: DialogBusEvent): void {
    const subs = perId.get(event.id);
    if (subs) {
      // Snapshot so a subscriber that unsubscribes mid-dispatch doesn't mutate
      // the set we're iterating over.
      for (const cb of Array.from(subs)) {
        cb(event);
      }
    }
    for (const cb of Array.from(all)) {
      cb(event);
    }
  }

  return {
    open(id, props) {
      const event: DialogBusEvent =
        props === undefined
          ? { type: "open", id }
          : { type: "open", id, props };
      emit(event);
    },
    close(id) {
      emit({ type: "close", id });
    },
    subscribe(id, cb) {
      let subs = perId.get(id);
      if (!subs) {
        subs = new Set();
        perId.set(id, subs);
      }
      subs.add(cb);
      return () => {
        const current = perId.get(id);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) {
          perId.delete(id);
        }
      };
    },
    subscribeAll(cb) {
      all.add(cb);
      return () => {
        all.delete(cb);
      };
    },
  };
}

// Default singleton. Components that don't need isolation should import this.
export const dialogBus: DialogBus = createDialogBus();
