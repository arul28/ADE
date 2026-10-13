"""Summarize ScrollDiagnostics JSONL per benchmark step (see bench-lanes-prs.sh).

Usage: bench-lanes-prs-summary.py <scroll-diagnostics.jsonl> <marks file>

The marks file holds one "<step name> <epoch seconds>" line per step. Each log
line is either a named event ("event": "cmd" | "frame.stall" | "res" | ...) or a
one-second frame window, which has no "event" key.
"""
import collections
import json
import sys


def read_marks(path):
    marks = []
    with open(path) as handle:
        for line in handle:
            parts = line.split()
            if len(parts) == 2:
                marks.append((parts[0], float(parts[1])))
    return marks


def read_events(path):
    """Read every complete JSON line. The app can still be writing the file,
    so a partial last line is skipped, not fatal."""
    events = []
    with open(path) as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def new_step():
    return {
        "commands": collections.Counter(),
        "stalls": [],
        "hitches": 0,
        "scroll_frames": 0,
        "bodies": collections.Counter(),
        "ready": {},
        "memory_mb": 0,
        "cpu": [],
    }


def step_at(marks, timestamp):
    current = None
    for name, started in marks:
        if timestamp >= started:
            current = name
    return current


def collect(events, marks):
    steps = collections.OrderedDict((name, new_step()) for name, _ in marks)
    start, end = marks[0][1], marks[-1][1]
    for event in events:
        timestamp = event.get("t")
        if timestamp is None or not start <= timestamp <= end:
            continue
        step = steps[step_at(marks, timestamp)]
        name = event.get("event")
        if name is None:
            step["hitches"] += event.get("hitches", 0)
            step["scroll_frames"] += event.get("scrollFrames", 0)
            for probe, stat in (event.get("probes") or {}).items():
                step["bodies"][probe] += stat["n"]
        elif name == "cmd":
            step["commands"][event["action"]] += 1
        elif name == "frame.stall":
            step["stalls"].append(event["ms"])
        elif name == "res":
            step["memory_mb"] = max(step["memory_mb"], event["memMB"])
            step["cpu"].append(event["cpuPct"])
        elif name.startswith(("laneDetail.", "prDetail.")):
            step["ready"].setdefault(name, event["ms"])
    return steps


def report(steps):
    all_commands = collections.Counter()
    all_stalls = []
    hitches = scroll_frames = 0
    for name, step in steps.items():
        if name == "end":
            continue
        all_commands.update(step["commands"])
        all_stalls += step["stalls"]
        hitches += step["hitches"]
        scroll_frames += step["scroll_frames"]
        cpu = round(sum(step["cpu"]) / max(1, len(step["cpu"])), 1)
        print(f"{name:16} cmds={sum(step['commands'].values()):2} {dict(step['commands']) or ''}")
        print(
            f"{'':16} stalls={len(step['stalls'])} sum={sum(step['stalls'])}ms"
            f" max={max(step['stalls'] or [0])}"
            f" hitches={step['hitches']}/{step['scroll_frames']}f"
        )
        print(
            f"{'':16} bodies={dict(step['bodies'])} ready={step['ready']}"
            f" memMax={step['memory_mb']} cpuAvg={cpu}"
        )
    print("TOTAL cmds", sum(all_commands.values()), dict(all_commands.most_common()))
    print(
        "TOTAL stalls", len(all_stalls), "sum", sum(all_stalls), "ms; hitches",
        hitches, "of", scroll_frames, "scroll frames",
    )


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    marks = read_marks(sys.argv[2])
    if len(marks) < 2:
        sys.exit("The marks file has fewer than two steps.")
    report(collect(read_events(sys.argv[1]), marks))


if __name__ == "__main__":
    main()
