# Summarizes ScrollDiagnostics JSONL per benchmark step (see bench-lanes-prs.sh).
import json,sys,collections
log,marks=sys.argv[1],sys.argv[2]
ph=[(l.split()[0],float(l.split()[1])) for l in open(marks) if l.strip() and not l.startswith("WARN")]
ev=[json.loads(l) for l in open(log) if l.strip()]
def phase(t):
    cur=None
    for n,s in ph:
        if t>=s: cur=n
    return cur
start,end=ph[0][1],ph[-1][1]
P=collections.OrderedDict((n,dict(cmds=collections.Counter(),stalls=[],hitches=0,hitchMs=0,scrollFrames=0,bodies=collections.Counter(),ready={},mem=0,cpu=[])) for n,_ in ph)
for e in ev:
    t=e.get("t");
    if t is None or t<start or t>end: continue
    p=P[phase(t)]; n=e.get("event")
    if n=="cmd": p["cmds"][e["action"]]+=1
    elif n=="frame.stall": p["stalls"].append(e["ms"])
    elif n=="res": p["mem"]=max(p["mem"],e["memMB"]); p["cpu"].append(e["cpuPct"])
    elif n and n.startswith(("laneDetail.","prDetail.")): p["ready"].setdefault(n,e["ms"])
    elif n is None:
        p["hitches"]+=e.get("hitches",0); p["hitchMs"]+=e.get("hitchMs",0); p["scrollFrames"]+=e.get("scrollFrames",0)
        for k,v in (e.get("probes") or {}).items(): p["bodies"][k]+=v["n"]
tot=collections.Counter(); totst=[]; toth=0; totf=0
for n,p in P.items():
    if n=="end": continue
    c=sum(p["cmds"].values()); tot.update(p["cmds"]); totst+=p["stalls"]; toth+=p["hitches"]; totf+=p["scrollFrames"]
    print(f"{n:16} cmds={c:2} {dict(p['cmds']) if c else ''}")
    print(f"{'':16} stalls={len(p['stalls'])} sum={sum(p['stalls'])}ms max={max(p['stalls'] or [0])} hitches={p['hitches']}/{p['scrollFrames']}f bodies={dict(p['bodies'])} ready={p['ready']} memMax={p['mem']} cpuAvg={round(sum(p['cpu'])/max(1,len(p['cpu'])),1)}")
print("TOTAL cmds",sum(tot.values()),dict(tot.most_common()))
print("TOTAL stalls",len(totst),"sum",sum(totst),"ms; hitches",toth,"of",totf,"scroll frames")
