/**
 * The pages an agent may point you to with an `ade://open/<place>` chip.
 *
 * Open-only on purpose: every place here just shows a page. Nothing on this
 * list starts, stops or changes anything, and a place runs only when a person
 * clicks its chip in a chat — the OS protocol handler refuses `open` links
 * (`main/services/deeplinks/protocolHandler.ts`), so a web page cannot fire one.
 * A place that would DO something needs its own design, not a row here.
 */

export type OpenPlace = {
  id: string;
  label: string;
  /** Extra words `ade settings find` matches. */
  keywords: readonly string[];
  /** An in-app route, or the Connections panel. */
  target: { kind: "route"; route: string } | { kind: "connections"; tab: "machines" | "mobile" | "web" };
};

export const OPEN_PLACES: readonly OpenPlace[] = [
  { id: "work", label: "Work", keywords: ["chats", "terminals", "sessions"], target: { kind: "route", route: "/work" } },
  { id: "lanes", label: "Lanes", keywords: ["worktrees", "branches"], target: { kind: "route", route: "/lanes" } },
  { id: "files", label: "Files", keywords: ["editor", "code"], target: { kind: "route", route: "/files" } },
  { id: "prs", label: "Pull requests", keywords: ["pr", "prs", "pull request", "review"], target: { kind: "route", route: "/prs" } },
  { id: "automations", label: "Automations", keywords: ["rules", "webhooks", "schedules"], target: { kind: "route", route: "/automations" } },
  { id: "history", label: "History", keywords: ["proof", "activity", "timeline"], target: { kind: "route", route: "/history" } },
  { id: "cto", label: "CTO", keywords: ["cto", "orchestrator"], target: { kind: "route", route: "/cto" } },
  { id: "connections", label: "Connections", keywords: ["machines", "computers", "remote", "pair"], target: { kind: "connections", tab: "machines" } },
  { id: "phone", label: "Connect a phone", keywords: ["ios", "iphone", "mobile", "phone", "pair"], target: { kind: "connections", tab: "mobile" } },
];

const PLACES_BY_ID = new Map(OPEN_PLACES.map((place) => [place.id, place]));

export function openPlaceById(id: string): OpenPlace | null {
  return PLACES_BY_ID.get(id.trim().toLowerCase()) ?? null;
}
