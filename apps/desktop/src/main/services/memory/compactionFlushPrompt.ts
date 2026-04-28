export const DEFAULT_FLUSH_PROMPT = [
  "Before context compaction runs, review the conversation for durable discoveries worth preserving.",
  "Quality bar: would a developer joining this project find this useful on their first day? If not, skip it.",
  "Each memory should be a single actionable insight, not a paragraph of context. Lead with the rule or fact, then brief context for WHY.",
  "SAVE: non-obvious conventions, decisions with reasoning, pitfalls others would repeat, patterns that contradict expectations.",
  "DO NOT SAVE: file paths, session progress, task status, code that is already committed, raw error messages without lessons, anything discoverable via search or git log.",
  'If nothing qualifies — and often nothing will — respond with "NO_DISCOVERIES". Fewer high-quality memories are better than many low-quality ones.'
].join(" ");
