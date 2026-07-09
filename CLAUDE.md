## Picking the right models for work delegation

Three tiers. Fable 5 for thinking, gpt-5.5 for building, Opus 4.8 for everything in between. Never use Sonnet or Haiku for anything.

| model    | use for |
|----------|---------|
| fable-5  | Deep research, architecture/design decisions, hard debugging, anything requiring sustained reasoning or judgment. Also the orchestrator: it writes the specs and prompts the other models execute. |
| gpt-5.5 (xhigh) | Pure implementation once a strong, self-contained prompt exists: clear-spec features, migrations, mechanical refactors, test writing, data analysis. Effectively free ‚Äî use liberally. |
| opus-4.8 | Everything else: reviews, moderate-complexity tasks, user-facing polish, second opinions. |

How to apply:
- The division of labor is think-then-delegate: Fable (you, or a fable subagent) does the research and produces a detailed spec; gpt-5.5 executes it. Never hand gpt-5.5 an underspecified task ‚Äî it can't ask clarifying questions mid-run, so the prompt must contain all context, file paths, constraints, and acceptance criteria.
- These are defaults, not limits. If a model's output doesn't meet the bar, redo the work with a smarter model without asking. Judge the output, not the price tag.
- Mechanics for gpt-5.5: it's only reachable through the Codex CLI. Run `codex exec "<self-contained prompt>"` via Bash ‚Äî my ~/.codex/config.toml already defaults to gpt-5.5 at xhigh reasoning, so no flags are needed. Use `codex exec -s read-only` for investigation/analysis; use `codex exec resume --last` to iterate on a prior run. `codex review` for an independent review perspective.
- Invoking codex from an agent shell (IMPORTANT): always close stdin and write output to a log file ‚Äî `codex exec "<prompt>" </dev/null >"$LOG" 2>&1`, backgrounded. In non-interactive shells stdin is an open pipe and codex blocks forever on "Reading additional input from stdin..." before doing any work; piping stdout through `tail`/`head` buffers everything so you can't see progress. Verify it's actually working by checking the log grows and a new session file appears under `~/.codex/sessions/<date>/`; no session file after ~2 min = wedged, kill and relaunch.
- Mechanics for Claude models: use the Agent/Workflow `model` parameter (`fable`, `opus`).
- Inside Workflows (where the model parameter only takes Claude models), reach gpt-5.5 via a thin wrapper: spawn an `opus` agent whose prompt says "run the following via `codex exec` in Bash and return its output verbatim, then verify the result compiles/passes tests before returning."
- Reviews of anything that ships: fable-5 or opus-4.8, optionally `codex review` as an extra independent perspective.