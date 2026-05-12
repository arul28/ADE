# Claude-compatible status line examples

ADE Code reads the same `statusLine` setting shape as Claude Code:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node docs/examples/statuslines/compact.js",
    "refreshInterval": 5
  }
}
```

The command receives one JSON payload on stdin and prints one or more lines.
Store the setting in `~/.claude/settings.json`, `.claude/settings.json`, or
`.claude/settings.local.json`.

- `compact.js` prints model, lane, context usage, and permission mode.
- `git-context.sh` prints the current branch plus context window usage.
