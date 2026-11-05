#!/usr/bin/env python3
"""ADE on Aether's codegen benchmark (https://www.runaether.dev/benchmarks/codegen).

Their clock: prompt sent -> the agent's one shell call (`sh hooks/probe.sh` in
github.com/aether-bench/supabase-stack) returns "UP after Ns". Lower is better.

  fresh:    `ade chat create` with the prompt; with --wake, a sleeping prepared
            Agent 37 machine is woken inside the clock first. With
            --machine agent37:ready, ADE claims and wakes a ready machine
            itself inside the clock, and the run waits for the pool to refill
            between tasks (run it from a checkout of the benchmark repo).
  followup: `ade chat send` to the same chat.

The stop time is the event's own timestamp in the chat transcript (the brain's
clock; Agent 37 VMs measured within ~0.15 s of a Mac). The time this client saw
it is printed too. A remote transcript is read with Agent 37 exec.
"""
import argparse, datetime, json, os, statistics, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent37  # noqa: E402

ADE = os.environ.get('ADE_CLI_PATH', 'ade')
parser = argparse.ArgumentParser()
parser.add_argument('--lane', help='lane id (on --machine when given); not used with agent37:ready')
parser.add_argument('--machine', help='account machine name; the chat runs there')
parser.add_argument('--project', default='repo', help='project name on --machine')
parser.add_argument('--instance', help='Agent 37 instance id of --machine (reads its transcript)')
parser.add_argument('--wake', action='store_true', help='sleep --instance before each fresh task, wake it inside the clock')
parser.add_argument('--runs', type=int, default=5)
parser.add_argument('--socket', help='drive this ADE brain socket instead of the machine brain')
parser.add_argument('--sleep-secs', type=int, default=20, help='how long the machine stays asleep before each wake')
parser.add_argument('--provider', default='claude')
parser.add_argument('--model', default='anthropic/claude-sonnet-5-5')
parser.add_argument('--effort', default='low')
parser.add_argument('--via')
parser.add_argument('--probe', default='sh hooks/probe.sh')
parser.add_argument('--transcripts', default=os.path.join(os.getcwd(), '.ade/transcripts/chat'),
                    help='local transcript folder (no --instance)')
parser.add_argument('--remote-transcripts', default='/root/repo/.ade/transcripts/chat')
args = parser.parse_args()

PROMPT = f'Check the dev stack: run `{args.probe}` in one shell call and reply with its last line only.'
FOLLOW_UP = f'Check it again: run `{args.probe}` in one shell call and reply with its last line only.'
READY = args.machine == 'agent37:ready'
REMOTE = ['--machine', args.machine, '--project', args.project] if args.machine and not READY else []
if not READY and not args.lane:
    parser.error('--lane is required unless --machine agent37:ready')
ADE_COMMAND = [ADE, '--socket', args.socket] if args.socket else [ADE]


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


TRANSCRIPT_PATHS = {}


def transcript_lines(session, instance=None):
    instance = instance or args.instance
    if instance:
        path = TRANSCRIPT_PATHS.get(session)
        if not path:
            # A ready machine's checkout lives wherever it was prepared; find it once.
            found = agent37.exec_on(instance, f'ls {args.remote_transcripts}/{session}.jsonl 2>/dev/null || '
                                    f'find /home /root -path "*/.ade/transcripts/chat/{session}.jsonl" 2>/dev/null | head -1', timeout=30)
            path = found.get('stdout', '').strip().splitlines()[0] if found.get('stdout', '').strip() else None
            if not path:
                return []
            TRANSCRIPT_PATHS[session] = path
        result = agent37.exec_on(instance, f'cat {path} 2>/dev/null', timeout=30)
        return result.get('stdout', '').splitlines()
    try:
        with open(os.path.join(args.transcripts, session + '.jsonl')) as handle:
            return handle.read().splitlines()
    except FileNotFoundError:
        return []


def wait_for_probe(session, since, limit=120, instance=None):
    """(event time, time seen) of the first probe result recorded at or after `since`."""
    while time.time() - since < limit:
        for line in transcript_lines(session, instance):
            # Claude records a tool_result; Codex records a completed command.
            if 'UP after' not in line or ('"tool_result"' not in line and '"type":"command"' not in line):
                continue
            event_time = timestamp(json.loads(line)['timestamp'])
            if event_time >= since - 0.5:
                return event_time, time.time()
        time.sleep(0.05)
    raise SystemExit(f'the probe never answered in chat {session}')


def ade(*command, wait_online=False):
    while True:
        result = subprocess.run([*ADE_COMMAND, *command], capture_output=True, text=True)
        # Right after a wake the account directory can still say offline for a
        # moment; a launch waits for the machine, inside the clock.
        if not (wait_online and result.returncode and 'is offline' in result.stdout + result.stderr):
            break
        time.sleep(0.25)
    if result.returncode:
        raise SystemExit(f'ade {" ".join(command[:2])} failed:\n{result.stdout[-800:]}{result.stderr[-800:]}')
    return result.stdout


def sleep_then_wake():
    agent37.call('POST', f'{agent37.API}/instances/{args.instance}/sleep', {})
    while agent37.status_of(args.instance) != 'sleeping':
        time.sleep(1)
    time.sleep(args.sleep_secs)  # 90+ lets the account directory mark it offline, as after a real idle spell
    started = time.time()
    agent37.call('POST', f'{agent37.API}/instances/{args.instance}/start', {})
    print(f'  wake call {time.time() - started:.2f}s', flush=True)
    return started


def wait_for_ready_machine(limit=900):
    """Block until the pool has a ready machine for this checkout (the previous run used one)."""
    started = time.time()
    while time.time() - started < limit:
        state = json.loads(ade('agent37', 'ready', '--json'))
        # Only this checkout's pool counts (--project names it), however many projects are kept ready.
        projects = [project for project in state.get('projects') or [] if project.get('projectName') == args.project]
        if not projects:
            raise SystemExit(f'no project named {args.project!r} is kept ready')
        # A failed prepare usually deletes its box and leaves only `failure`.
        if any(project.get('failed') or project.get('failure') for project in projects):
            raise SystemExit(f'a ready-machine prepare failed: {[p.get("failure") for p in projects]}')
        if any((project.get('ready') or 0) >= 1 for project in projects):
            print(f'  pool ready after {time.time() - started:.0f}s', flush=True)
            return
        time.sleep(5)
    raise SystemExit('no ready machine after 15 minutes')


fresh, follow_ups = [], []
for run in range(args.runs):
    if READY:
        wait_for_ready_machine()
    create = ['chat', 'create', *([] if READY else ['--lane', args.lane]), '--provider', args.provider, '--model', args.model,
              '--reasoning-effort', args.effort, '--permissions', 'full-auto', '--no-parent',
              '--title', f'codegen bench {run}', '--prompt', PROMPT, '--json',
              *(['--machine', 'agent37:ready'] if READY else REMOTE)]
    if args.via:
        create += ['--via', args.via]
    started = sleep_then_wake() if args.wake else time.time()
    created = json.loads(ade(*create, wait_online=args.wake))
    session = (created.get('session') or {}).get('id') or created.get('id') or created.get('sessionId')
    ready = created.get('readyMachine') or {}
    instance = ready.get('instanceId')
    on_machine = ['--machine', ready['machineKey']] if READY else REMOTE
    if READY:
        print(f"  claimed {ready.get('name')} ({instance}): wake {ready.get('wakeMs')} ms, online {ready.get('onlineMs')} ms, "
              f"sent {ready.get('sentMs')} ms", flush=True)
        open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.claimed-instances'), 'a').write(f'{instance}\n')
    event_time, seen = wait_for_probe(session, started, instance=instance)
    fresh.append(event_time - started)
    print(f'fresh {run}: {event_time - started:.2f}s (seen {seen - started:.2f}s) chat {session}', flush=True)
    ade('chat', 'wait', session, '--for', 'idle', '--timeout-ms', '120000', *on_machine)

    started = time.time()
    ade('chat', 'send', session, '--text', FOLLOW_UP, *on_machine)
    event_time, seen = wait_for_probe(session, started, instance=instance)
    follow_ups.append(event_time - started)
    print(f'follow-up {run}: {event_time - started:.2f}s (seen {seen - started:.2f}s)', flush=True)
    ade('chat', 'wait', session, '--for', 'idle', '--timeout-ms', '120000', *on_machine)


def summary(values):
    return f'{statistics.median(values):.2f}s median, {min(values):.2f}-{max(values):.2f}s over {len(values)}'


print('FRESH    ', summary(fresh))
print('FOLLOW-UP', summary(follow_ups))
