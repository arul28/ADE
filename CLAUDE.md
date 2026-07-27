## Picking the right models for work delegation

**Applicability — read this first.** Everything below describes the *Fable-orchestrated* workflow:
Fable 5 does the thinking and writes specs, gpt-5.6-sol executes them. **It applies only when the
orchestrating agent is Fable 5.** If you are any other model — Opus, Sonnet, or anything else —
this section does not govern your delegation, and you should not route work to Codex/gpt-5.6-sol
on its account. Check what model you are before applying any of it.

**If you are not Fable:** do the work yourself, and delegate to `opus` subagents (Claude Opus 5)
when you need parallelism, an independent review perspective, or a second opinion. Sonnet is
acceptable only for genuinely trivial mechanical subtasks; never use Haiku. You may still use
Codex deliberately — for an independent review via `codex review`, or when the user asks for it —
but not as your default implementation path.

### The Fable-orchestrated tiers

Three tiers. Fable 5 for thinking, gpt-5.6-sol for building, Opus 5 for everything in between.
With a tight, self-contained prompt Opus also handles implementation well when gpt-5.6-sol is
unavailable.

| model    | use for |
|----------|---------|
| fable-5  | Deep research, architecture/design decisions, hard debugging, anything requiring sustained reasoning or judgment. Also the orchestrator: it writes the specs and prompts the other models execute. |
| gpt-5.6-sol (high/xhigh) | Pure implementation once a strong, self-contained prompt exists: clear-spec features, migrations, mechanical refactors, test writing, data analysis. Effectively free — use liberally. |
| opus-5 | Everything else: reviews, moderate-complexity tasks, user-facing polish, second opinions. |

How to apply:
- The division of labor is think-then-delegate: Fable does the research and produces a detailed spec; gpt-5.6-sol executes it. Never hand gpt-5.6-sol an underspecified task — it can't ask clarifying questions mid-run, so the prompt must contain all context, file paths, constraints, and acceptance criteria.
- These are defaults, not limits. If a model's output doesn't meet the bar, redo the work with a smarter model without asking. Judge the output, not the price tag.
- Mechanics for gpt-5.6-sol: it's only reachable through the Codex CLI. Run `codex exec -m gpt-5.6-sol "<self-contained prompt>"` via Bash — my ~/.codex/config.toml defaults to gpt-5.6-sol at xhigh reasoning; pass `-m gpt-5.6-sol` (and `-c model_reasoning_effort=xhigh`) explicitly whenever the config default differs. Use `codex exec -s read-only` for investigation/analysis; use `codex exec resume --last` to iterate on a prior run. `codex review` for an independent review perspective.
- Invoking codex from an agent shell (IMPORTANT): always close stdin and write output to a log file — `codex exec "<prompt>" </dev/null >"$LOG" 2>&1`, backgrounded. In non-interactive shells stdin is an open pipe and codex blocks forever on "Reading additional input from stdin..." before doing any work; piping stdout through `tail`/`head` buffers everything so you can't see progress. Verify it's actually working by checking the log grows and a new session file appears under `~/.codex/sessions/<date>/`; no session file after ~2 min = wedged, kill and relaunch.
- Mechanics for Claude models: use the Agent/Workflow `model` parameter (`fable`, `opus`).
- Inside Workflows (where the model parameter only takes Claude models), reach gpt-5.6-sol via a thin wrapper: spawn an `opus` agent whose prompt says "run the following via `codex exec` in Bash and return its output verbatim, then verify the result compiles/passes tests before returning."
- Reviews of anything that ships: fable-5 or opus-5, optionally `codex review` as an extra independent perspective.
