import type { EventBus } from "./eventBus";

export type InvalidationDomain = "lanes" | "sessions" | "chats" | "prs" | "files" | "github" | "rebase";

export type InvalidationEvent = {
  tables: string[];
  domains: InvalidationDomain[];
  at: string;
};

export type InvalidationEvents = {
  invalidation: InvalidationEvent;
};

export function createInvalidationScheduler(
  onTablesChanged: (listener: (tables: Set<string>) => void) => () => void,
  bus: EventBus<InvalidationEvents>,
  debounceMs = 250
): () => void {
  let pendingTables = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    const tables = Array.from(pendingTables);
    pendingTables = new Set();
    const domains = Array.from(new Set(tables.flatMap(tableDomains)));
    if (domains.length === 0) return;
    bus.emit("invalidation", {
      tables,
      domains,
      at: new Date().toISOString(),
    });
  }

  const unsubscribe = onTablesChanged((tables) => {
    for (const table of tables) pendingTables.add(table);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

function tableDomains(table: string): InvalidationDomain[] {
  const normalized = table.toLowerCase();
  const domains = new Set<InvalidationDomain>();
  if (normalized.includes("lane") || normalized.includes("worktree")) {
    domains.add("lanes");
    domains.add("sessions");
  }
  if (
    normalized.includes("terminal") ||
    normalized.includes("pty") ||
    normalized.includes("runtime") ||
    normalized.includes("session")
  ) {
    domains.add("sessions");
  }
  if (normalized.includes("chat") || normalized.includes("agent") || normalized.includes("turn")) {
    domains.add("chats");
  }
  if (
    normalized.includes("pull_request") ||
    normalized === "prs" ||
    normalized.startsWith("pr_") ||
    normalized.includes("queue") ||
    normalized.includes("integration")
  ) {
    domains.add("prs");
    domains.add("github");
  }
  if (normalized.includes("file") || normalized.includes("tree") || normalized.includes("git_status")) {
    domains.add("files");
  }
  if (normalized.includes("github") || normalized.includes("remote")) {
    domains.add("github");
  }
  if (normalized.includes("rebase") || normalized.includes("conflict")) {
    domains.add("rebase");
  }
  return Array.from(domains);
}
