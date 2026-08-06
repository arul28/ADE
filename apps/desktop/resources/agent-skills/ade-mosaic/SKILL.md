---
name: ade-mosaic
description: Use this skill when you want to ask the user for structured input (choices, toggles, numbers, short text, approvals) inside an ADE chat. Emit a fenced mosaic code block and ADE renders it as a native interactive card; the user's answers come back as your next user message.
---

# ADE Mosaic cards

Emit a fenced code block with language `mosaic` containing strict JSON. ADE
desktop renders it as an interactive card in the transcript. When the user
submits, their selections arrive as the next user message: readable lines
plus a `json` fence with `{"mosaic":1,"values":{...}}` keyed by element id.

The card is data only — no expressions, no code, no host actions. If the JSON
is malformed or uses unknown element types or versions, ADE shows the raw
fence instead, so validate your JSON.

Terminal (TUI) chats show a one-line summary; iOS shows the raw fence. Ask
plain-text questions when the user is likely not on desktop.

## Schema (v1)

Top level: `{"v": 1, "title"?, "submitLabel"?, "elements": [...]}` — 1 to 24
elements. Interactive elements need a unique `id`.

| Element | Shape |
|---|---|
| Text | `{"type":"text","text":"..."}` |
| Single select | `{"type":"select","id":"env","label"?,"options":[{"value":"prod","label"?}],"value"?}` |
| Multi select | `{"type":"multiselect","id":"features","label"?,"options":[...],"values"?}` |
| Number / slider | `{"type":"number","id":"n","label"?,"min"?,"max"?,"step"?,"value"?}` (renders a slider when both min and max are set) |
| Short text | `{"type":"input","id":"name","label"?,"placeholder"?,"value"?,"maxLength"?}` |
| Approve / deny | `{"type":"approval","id":"go","label"?,"approveLabel"?,"denyLabel"?}` |
| Key-value table | `{"type":"table","rows":[{"key":"...","value":"..."}]}` (display only) |

Limits: 40 options per select, 50 table rows, labels ≤ 200 chars, values
≤ 1000 chars.

## Example

```mosaic
{
  "v": 1,
  "title": "Release checklist",
  "elements": [
    {"type": "text", "text": "v1.3.0 is tagged and CI is green."},
    {"type": "table", "rows": [
      {"key": "Commits", "value": "18"},
      {"key": "Risk", "value": "low"}
    ]},
    {"type": "select", "id": "channel", "label": "Channel",
     "options": [{"value": "beta"}, {"value": "stable"}], "value": "beta"},
    {"type": "multiselect", "id": "targets", "label": "Targets",
     "options": [{"value": "mac"}, {"value": "ios"}]},
    {"type": "number", "id": "rollout", "label": "Rollout %", "min": 5, "max": 100, "step": 5, "value": 25},
    {"type": "approval", "id": "ship", "label": "Publish the release?"}
  ],
  "submitLabel": "Send"
}
```

## Guidance

- `text` and `table` are display-only, so a card needs at least one
  interactive element to be submittable; use the display rows for the context
  the user needs to decide.
- Do NOT use a mosaic card for plan approval or permission prompts — ADE has
  dedicated native surfaces for those.
