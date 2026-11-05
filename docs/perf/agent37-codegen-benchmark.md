# ADE on Agent 37 vs Aether's codegen benchmark

Goal: beat every row of Aether's "Time to a working dev environment"
benchmark (https://www.runaether.dev/benchmarks/codegen, run 2026-11-02)
with ADE on Agent 37 cloud machines. Harness: `scripts/perf/agent37-codegen/`.

## What their benchmark measures

One repo (github.com/aether-bench/supabase-stack): a local Supabase stack
(Postgres, PostgREST, GoTrue, Realtime, Storage, Studio, Inbucket) and a Node
app whose `/health` answers only after it queries Postgres. Claude Code,
Sonnet 5.5 at low effort. The clock runs from sending the prompt until the
agent's one shell call (`sh hooks/probe.sh`) returns. Five fresh tasks per
product, each followed by one follow-up; plus Phoronix `pts/node-web-tooling`.

| Row | Aether | Replicas | Conductor Cloud | To win |
|---|---|---|---|---|
| Fresh task (s, lower is better) | **19.4** | 31.9 | 73.5 | < 19.4 |
| Follow-up (s) | 16.7 | 6.2 | **3.0** | < 3.0 |
| CPU, node-web-tooling (runs/s, higher is better) | **25.7** (Ryzen 9 9950X) | 19.1 | 15.3 | > 25.7 |

Aether's fresh number is "a start that found a prepared seed": dependencies,
pulled images and the running stack baked into a per-project snapshot.

## Measured so far (2026-11-05)

Agent 37 VM 4 vCPU / 8 GB / 20 GB, Intel Xeon E-2388G, region us, ADE
1.2.129-beta.7 on the VM, driven from a Mac with `ade chat create --machine`.

| What | Result |
|---|---|
| VM create → running | ~1 s |
| Cold bring-up (clone, `npm ci`, pull 8.3 GB of images, start) | 93 s |
| Warm start (images cached, stack stopped) | 23.8 s |
| Sleep keeps the stack? | **Yes**: memory snapshot, uptime, all 9 containers and the brain survive |
| Wake call / wake → `/health` answers | 0.9–1.2 s / 1.8 s |
| Fork of the warm VM | 167 s; boots fresh, the app is not running |
| CPU, `pts/node-web-tooling` | **20.58 runs/s** (±2.3%) |

ADE end to end, prompt → probe result (event time; client-seen time is
~0.3–0.5 s later because the remote transcript is read through Agent 37 exec):

| Setup | Fresh task | Follow-up |
|---|---|---|
| Local Mac lane, Claude Code + Sonnet 5.5 low (fake `/health`) | 5.28 s median (2 runs) | 2.47 s |
| Agent 37 VM awake, Codex + gpt-5.6-luna (via the account's OpenAI key) | 2.47 s median (3 runs) | 1.75 s |
| Agent 37 VM **asleep** 20 s, woken inside the clock, Codex + gpt-5.6-luna | 4.41 s median (4.00–4.47, 3 runs) | 1.78 s |
| Agent 37 VM **asleep 100 s** (directory shows it offline), released brains | first remote call 13–30 s after the wake | |
| Same, with this branch's fixes on both ends | **6.06 s median (5.71–7.50, 5 runs)** | **2.09 s (1.85–2.25)** |

Codex stands in for Claude until the VM has a Claude sign-in (agents can't
add one). The official run uses Claude Code + Sonnet 5.5 low.

### Ready machines, as shipped (2026-11-05, main e57f594f4)

The product path: "Keep a cloud machine ready" for supabase-stack (VM,
4 CPU / 8 GB, setup `npm ci` + `sh hooks/start.sh`), then
`ade chat create --machine agent37:ready`. Each fresh task claims a prepared
machine that has been **asleep** with the stack running, wakes it inside the
clock, and the pool prepares the next one (82–184 s). The VMs run ADE
1.2.129-beta.7 from template `ade-ready-dev`, which predates the reconnect
fixes above. Codex + gpt-5.6-luna low, 5 runs:

| Run | Wake call | Machine online | Prompt sent | Fresh task | Follow-up |
|---|---|---|---|---|---|
| 0 | 0.91 s | 11.7 s | 12.2 s | 14.77 s | 1.75 s |
| 1 | 0.84 s | 12.9 s | 13.4 s | 15.94 s | 1.87 s |
| 2 | 5.15 s | 14.3 s | 14.7 s | 17.90 s | 1.71 s |
| 3 | 5.25 s | 10.2 s | 10.5 s | 13.17 s | 1.89 s |
| 4 | 3.26 s | 11.7 s | 12.2 s | 15.08 s | 2.01 s |
| **Median** | | | | **15.08 s** (vs Aether 19.4) | **1.87 s** (vs Conductor 3.0) |

Prompt sent → probe result is 2.6–3.2 s; the rest is the machine coming back
online. Runs 2–4 claimed a machine that was still going to sleep; the claim
now waits through that instead of failing (below). Most of the ~11 s from
wake to online is beta.7's slow resume detection; with this repo's reconnect
fixes on the VM it was ~5 s (table above), which would put the fresh task
near 8–9 s once a beta carries them.

### Why a long sleep cost 13–30 s, and the fixes

Short sleeps hide it: the machine is still "online" in the account directory.
After about a minute it is not, and three things stacked up:

1. The brain noticed the wake only on its next 15 s check, and the relay
   control socket only on its next 30 s ping (10 s deadline). Now a wake
   pings the control socket at once with a 3 s deadline (a miss reconnects),
   and `ADE_SUSPEND_GAP_TICK_MS=1000` makes the wake check run every second
   on cloud machines. Wake → "online" in the directory went 13 s → ~6 s.
2. The Mac refused from its 15 s directory cache ("is offline. Nothing was
   sent") even after the directory said online. A cached offline entry is now
   re-read once before refusing.
3. The CLI/agent connector tried the box's private address (`10.90.0.17`)
   first, for 10 s, on every new connection, and never learned it was dead.
   It now caps LAN/tailnet at 3/5 s when a relay is behind them and demotes
   a route after two silent failures, as the desktop connector already did.

Wake → first successful remote call: 13.1 / 29.0 s before, 4.9 s after.

## How ADE wins, and what it needs

A prepared machine kept **asleep** (repo cloned, setup done, services
running, signed in) is ADE's version of Aether's seed: waking it costs about
1.8 s, and ADE reconnects right away. Asleep it bills only disk. Being built in
the `agent37-ready-machines` lane:

1. A VM template with Docker (ADE's template runs as `node` with no root or
   Docker, so a Docker stack can't run on an ADE VM today).
2. `IS_SANDBOX=1` for the brain on Agent 37 machines: Claude Code refuses
   full-auto as root, and Agent 37's Ubuntu VMs run as root.
3. "Keep a cloud machine ready" per project, and starting a chat on it,
   reachable from the CLI (Agent 37 actions are desktop-only today).

CPU is Agent 37's hardware: their VM and performance types are Xeon
E-2388G / E-2386G. 20.58 runs/s beats Replicas and Conductor but not a Ryzen
9950X; no ADE change moves it. It goes in the founder asks.

## Bugs found on the way

- Claude Code through an OpenAI key (`--via key:openai`) fails three ways:
  on a VM, `gpt-5.6-luna` gets `400 Unsupported parameter: 'max_tokens'` and
  `gpt-5.5` gets `400 unknown provider for model ade-openai-default/gpt-5.5`;
  on the Mac the chat errors with "could not authenticate" Claude Code.
  Fixed (2026-11-05): OpenAI goes through the proxy's Responses translation,
  which sends no `max_tokens`; a launch waits until the proxy has loaded a
  model it just wrote (its first request 0.2 s after the write was the
  "unknown provider"); and the Mac's stored OpenAI key is revoked (OpenAI
  answers "Incorrect API key"), which is its "could not authenticate".
- A ready machine claimed in the seconds after the pool marked it ready
  (still going to sleep) failed with "The Agent 37 machine is busy changing
  state". The claim now retries the wake through Agent 37's transient answers
  for up to 15 s.
- The installer needs the `v` prefix in `ADE_VERSION` (`v1.2.129-beta.7`); a
  bare version 404s with no hint. Fixed: a bare version means the same tag,
  and a missing release names itself and links the releases page.

### Wake after a long sleep, with #2055 on the machine (2026-11-05)

A 2/4 box from a template of 1.2.129-beta.8 (which carries #2055) with this
branch's brain on it, asleep 150 s (shown offline) each time:

| Run | Wake call | Shown online | First `--machine` call (CLI, end to end) |
|---|---|---|---|
| 0 | 0.75 s | 0.82 s | 7.07 s |
| 1 | 2.24 s | 2.31 s | 7.32 s |
| 2 | 0.92 s | 0.97 s | (desktop Connect: 6.37 s) |

Online now follows the wake by under 0.1 s (beta.7: about 11 s; the target was
5 s). The first call still takes 6 to 7 s: the box's relay control socket is
ready about 7.7 s after the wake (zombie control detected at once, reopened
at 2.7 s, ready at 7.7 s), and a connect in between used to fail into a
re-pair (one 23 s failure in three); a just-woken machine's connect now
retries for up to 45 s instead.

## Reproduce

Ready machines (the product path): turn on "Keep a cloud machine ready" for a
supabase-stack checkout, then, from a full-auto chat on the same brain as the
CLI (a caller ADE can't place gets `default` permissions, and Codex is then
sandboxed off the network):

```sh
export AGENT37_API_KEY=$(ade secrets get AGENT37_API_KEY --text)
python3 scripts/perf/agent37-codegen/bench.py --machine agent37:ready --runs 5 \
  --provider codex --model openai/gpt-5.6-luna --via key:openai
```

Claimed machine ids land in `scripts/perf/agent37-codegen/.claimed-instances`;
delete them afterwards.

A hand-built VM:

```sh
export AGENT37_API_KEY=$(ade secrets get AGENT37_API_KEY --text)
python3 scripts/perf/agent37-codegen/bench.py --machine <vm> --instance <id> \
  --lane <primary lane id on the vm> --wake --runs 5
```

The VM needs ADE installed and signed in, the repo registered as project
`repo` at `/root/repo`, its stack started once, and Claude signed in.
