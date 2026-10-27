# Network and phone benches

Measures what ADE costs over a slow link: a phone's cold connect and reconnect, the bytes per message
type, and (with the same proxy) a remote desktop. Results and ceilings live in
`docs/perf/macos-baseline.md`, section **Network and remote**.

| File | What it is |
|---|---|
| `slow-proxy.mjs` | TCP pass-through proxy with 3g (400 kbps, 400 ms RTT), lte (10 Mbps, 60 ms) and lan profiles. Counts bytes each way and connections. No admin rights, any OS. |
| `phone-sync.bench.mts` | Headless phone. Speaks the sync protocol as the iOS app does and times each connect step through the proxy. |
| `make-synthetic-project.mts` | Seeded 1,000-chat project (20 lanes, a 1,000-turn chat, an icon). Same seed, same bytes. |
| `rig.sh`, `rig-pair.mts`, `rig-scenarios.mjs` | Three-machine rig: a dev desktop paired (through its own pairing call) with two measurement brains behind slow proxies (`wan30` = 30 ms RTT), and the scenarios run on it: reload → rows from every machine, cross-machine chat switches and project tab switches, each with proxy bytes. Sources are make-real-load-copy copies; run up → measure → down in one heavy slot. See the header of `rig.sh`. |
| `make-real-load-copy.mts` | Runnable copy of a real project for real-load runs: database by SQLite backup, transcripts as APFS clones, `git clone --local`, one worktree per active lane, every path rewritten to the copy, the copied sync cluster record cleared, origin pointed nowhere. Read-only on the source. Numbers only; never commit or show a copy. |
| `measure-brain.mjs` | Starts and stops an isolated sync-ON brain. |
| `guard-sync-port.cjs` | Preload that keeps a measurement brain from touching the machine (below). |
| `run-phone-matrix.sh` | One bench run per heavy lock, for a long matrix. |

## Run it

```bash
npm --prefix apps/ade-cli run build
D=<scratch dir>                                    # scratch, outside any repo; big files go here
cd apps/ade-cli
npx tsx ../../scripts/perf/net/make-synthetic-project.mts $D/projects/synth   # prints projectId, bigChatId
cd ../..
node scripts/perf/net/measure-brain.mjs start --dir $D          # prints {"syncPort": 8788, ...}
node scripts/perf/net/measure-brain.mjs cli --dir $D --cwd $D/projects/synth -- projects add $D/projects/synth
echo '{"pin":"424242","updatedAt":"2026-01-01T00:00:00.000Z"}' > $D/home/.ade/secrets/sync-pin.json
cd apps/ade-cli
npx tsx ../../scripts/perf/net/phone-sync.bench.mts pair --target 127.0.0.1:<syncPort> --pin 424242 --state $D/phone.json
npx tsx ../../scripts/perf/net/phone-sync.bench.mts all --target 127.0.0.1:<syncPort> --state $D/phone.json \
  --project <registry project id from pair> --chat <bigChatId> --profiles 3g,lte,lan --runs 3
cd ../.. && node scripts/perf/net/measure-brain.mjs stop --dir $D
```

`pair` prints the machine's project ids (the registry ids, `project_<hash>`); pass the synthetic one to
`--project`. Wrap every run in the machine's heavy lock when other agents share the machine
(`run-phone-matrix.sh` does it per run).

## A/B runs

Copy the "before" build next to `dist/` (`rsync -a --exclude '*.map' apps/ade-cli/dist/ apps/ade-cli/perfdist-before/`,
keep it out of git with `.git/info/exclude`), start one brain per build with
`measure-brain.mjs start --dir <scratch>/A --n a --cli apps/ade-cli/perfdist-before/cli.cjs` and
`--dir <scratch>/B --n b`, each with its own copy of the synthetic project, and interleave runs
(A, B, A, B) one per heavy lock. Each brain gets its own sync-host lock file, so they never see
each other. `phone-sync.bench.mts --phone legacy` acts as the app before the P1 pass and
`--phone new` as the current one; `--during-drop "<command>"` changes the project while a
reconnecting phone is away (rename a chat with the `cli` command). `desktop-remote.bench.mts
--pipelined` sends `projects.list` behind `ade/initialize`, as the desktop does now. In `--phone new` mode a
reconnect also carries its first requests in the hello (`hello.pipelined`: the chat resume, the
roster, lanes, work, PRs), declares the ack window and asks for work-list deltas; against a brain
without those features it falls back to sending them itself.

## What a phone run measures

From the moment the socket starts to open: `helloOk`, `projectRow` (the phone's project-row gate, on
iOS's 200 ms poll grid), `workUsable` (lanes and work sessions answered), `roster`, `catalog`,
`chat` (the biggest chat's first page), `prs`, `done` (all of those), and `caughtUp` (replica acked
up to hello_ok's `serverDbVersion`, capped by `--catchup-cap-ms`, 120 s by default, since a big
backlog takes minutes; past the cap it records how many versions were left). Bytes per message type:
wire (as sent, after per-envelope deflate and binary frames) and decoded (the JSON the phone parses).

**Cold**: paired, project known, nothing cached (dbVersion 0, no roster seq, no lane signature, no
chat cursor). **Reconnect**: the same phone after a 5 s drop, holding a caught-up replica, the roster
seq, the lane signature and the chat cursor.

The client copies the iOS app (`apps/ios/ADE/Services/SyncService.swift`): hello capabilities
(`changesetAck`, `chunkedEnvelopes`, `relayReauthorizeV1`, `binaryEnvelopes`, `foldedReplay`,
`mobileChatSlimV1`), per-envelope deflate (iOS cannot negotiate permessage-deflate, so the client
refuses it), `roster_subscribe` and `project_catalog_request` right after hello_ok, the project-row
gate, then `lanes.refreshSnapshots` (with the iOS arguments) and `work.listSessions {limit: 200}` in
parallel, `prs.list` then `prs.refresh` for active PRs, `chat_subscribe {maxBytes: 262144}`. It does
not apply changes to a SQLite replica, so phone-side apply time is not in these numbers; it acks
each batch as soon as it is parsed. It authenticates with a PIN pairing and paired auth without a
DPoP proof (a few hundred bytes less hello than an iPhone).

## Why the measurement brain needs all that isolation

A sync host is a machine-wide singleton, and on a machine whose installed brain is running these
are all real hazards. Each is handled by `measure-brain.mjs` plus `guard-sync-port.cjs`:

- Sync turns on only when `ADE_HOME` is `$HOME/.ade`, so the brain gets a fake `HOME`.
- The listener always tries 8787 first, and retries it every few minutes. The guard makes 8787 look
  taken, so the brain lands on 8788+ even when the installed brain restarts.
- The singleton lease scans every listener on 8787–8999 and refuses to host while another ADE
  listens; the stale-holder reaper reads the same scan before it stops a holder. The guard answers
  those scans with "nothing", so the measurement brain never targets another process.
- The orphan reapers list every process (`ps -axo`) and SIGKILL orphaned `dns-sd` and stale brains.
  The guard answers those listings with nothing.
- The host publishes itself with `tailscale serve --tcp=<port>` and turns off forwards it thinks are
  stale. That is machine-wide config. The guard makes every `tailscale` call a no-op.
- ADE's cloud (relay, push relay, analytics, crash reports): lookups of `ade-app.dev`, `posthog.com`
  and `sentry.io` fail, so a scratch home never publishes itself.
- `ADE_SYNC_BIND_HOST=127.0.0.1`: no LAN listener, no Bonjour.

Also: run the CLI from inside the project you mean (`--cwd`). Run from a directory that has its own
`.ade` (such as `/tmp` on some machines), the brain registers and opens that directory's database.

## Proxy model and limits

Per connection and direction: bytes leave no faster than the profile's rate, arrive half an RTT
later, and the upstream connect is held one RTT (a TCP handshake). Not modelled: loss, TCP slow
start, TLS, a bandwidth pool shared by connections. Good for comparing builds and products under one
condition; not a substitute for a real phone on a real cell network.
