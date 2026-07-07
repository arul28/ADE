export type Unsubscribe = () => void;

export class EventBus<TEvents extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof TEvents, Set<(payload: unknown) => void>>();

  on<K extends keyof TEvents>(event: K, listener: (payload: TEvents[K]) => void): Unsubscribe {
    let eventListeners = this.listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }
    eventListeners.add(listener as (payload: unknown) => void);
    return () => {
      eventListeners?.delete(listener as (payload: unknown) => void);
    };
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) return;
    for (const listener of Array.from(eventListeners)) {
      listener(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
