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
| Agent 37 VM **asleep**, woken inside the clock, Codex + gpt-5.6-luna | 4.41 s median (4.00–4.47, 3 runs) | 1.78 s |

Codex stands in for Claude until the VM has a Claude sign-in (agents can't
add one). The official run uses Claude Code + Sonnet 5.5 low.

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
- The installer needs the `v` prefix in `ADE_VERSION` (`v1.2.129-beta.7`); a
  bare version 404s with no hint.

## Reproduce

```sh
export AGENT37_API_KEY=$(ade secrets get AGENT37_API_KEY --text)
python3 scripts/perf/agent37-codegen/bench.py --machine <vm> --instance <id> \
  --lane <primary lane id on the vm> --wake --runs 5
```

The VM needs ADE installed and signed in, the repo registered as project
`repo` at `/root/repo`, its stack started once, and Claude signed in.
