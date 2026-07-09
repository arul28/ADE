import type { AutomationRuleDraft } from "../../../../shared/types";

// The project tab host renders `<Routes location={route}>` from a stored route
// STRING (App.tsx), which strips `location.state` for every descendant — so a
// navigate-with-state handoff from the templates route can never deliver its
// draft. This module-scoped mailbox carries it instead: the templates page
// stashes, the automations page takes exactly once.
let pendingTemplateDraft: AutomationRuleDraft | null = null;

export function stashTemplateDraft(draft: AutomationRuleDraft): void {
  pendingTemplateDraft = draft;
}

export function takeTemplateDraft(): AutomationRuleDraft | null {
  const draft = pendingTemplateDraft;
  pendingTemplateDraft = null;
  return draft;
}
