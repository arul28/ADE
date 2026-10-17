import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc";
import type { OpenProjectBinding } from "../shared/types/core";
import type {
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
} from "../shared/types/remoteRuntime";
import { createPinnedRuntimeEvents } from "./pinnedRuntimeEvents";

// A remote binding whose runtime is a deterministic in-memory buffer. The
// anchor (`replay: false` at cursor 0) mirrors runtimeBridge.ts today: the first
// anchor opens the push subscription and answers the head, an already-open one
// answers nextCursor 0. A replaying poll re-subscribes after its snapshot, which
// is when main sets the subscription up.
const PIN = {
  kind: "remote",
  key: "remote:target-1:project-1",
  targetId: "target-1",
  runtimeName: "studio",
  projectId: "project-1",
  rootPath: "/work/project",
  displayName: "project",
} as OpenProjectBinding;

const CATEGORY = "dag_mutation" as const;

// Timing model. A request is answered from the buffer when it arrives; the reply
// lands REPLY_MS later, the way an IPC round trip does, so polls sent close
// together are in flight together. Listeners start STAGGER_MS apart, as timers
// that were set up in separate tasks drift.
const REPLY_MS = 3;
const STAGGER_MS = 1;

type FakeRuntime = {
  epoch: string;
  nextId: number;
  seq: number;
  events: RemoteRuntimeBufferedEvent[];
  subscribed: boolean;
  rpcCount: number;
  releaseCount: number;
  failNext: number;
  downUntilMs: number;
  gapOnNextPoll: boolean;
  /** When each request reached the runtime, so retry timing can be checked. */
  requestAt: number[];
};

type Listener = {
  attachedAt: number;
  deliveries: Array<[number, number, unknown]>;
  resyncs: number[];
  stop: () => void;
};

function createRig() {
  const startedAt = Date.now();
  const now = (): number => Date.now() - startedAt;
  const runtime: FakeRuntime = {
    epoch: "E1",
    nextId: 0,
    seq: 0,
    events: [],
    subscribed: false,
    rpcCount: 0,
    releaseCount: 0,
    failNext: 0,
    downUntilMs: -1,
    gapOnNextPoll: false,
    requestAt: [],
  };
  // Keyed by seq, which keeps counting across a restart, unlike the buffer id.
  const appendedAt = new Map<number, number>();
  const head = () => runtime.events.at(-1)?.id ?? 0;
  const isDown = () => now() < runtime.downUntilMs;

  // The answer is fixed when the request arrives, from the state at that moment.
  const answer = (request: RemoteRuntimeStreamEventsRequest): RemoteRuntimeStreamEventsResult => {
    runtime.rpcCount += 1;
    runtime.requestAt.push(now());
    const cursor = request.cursor ?? 0;
    if (request.replay === false && cursor === 0) {
      if (runtime.subscribed) return { events: [], nextCursor: 0, hasMore: false };
      runtime.subscribed = true;
      return { events: [], nextCursor: head(), hasMore: false, eventEpoch: runtime.epoch };
    }
    const limit = request.limit ?? 200;
    const pending = runtime.events.filter((event) => event.id > cursor);
    const batch = pending.slice(0, limit);
    const result: RemoteRuntimeStreamEventsResult = {
      events: batch,
      nextCursor: batch.at(-1)?.id ?? cursor,
      hasMore: pending.length > batch.length,
      eventEpoch: runtime.epoch,
    };
    if (runtime.gapOnNextPoll) {
      result.gap = true;
      runtime.gapOnNextPoll = false;
    }
    return result;
  };

  const streamEvents = async (
    request: RemoteRuntimeStreamEventsRequest,
  ): Promise<RemoteRuntimeStreamEventsResult> => {
    const anchor = request.replay === false && (request.cursor ?? 0) === 0;
    const result = answer(request);
    await new Promise<void>((resolve) => setTimeout(resolve, REPLY_MS));
    // Failures arrive as replies, as they do over IPC, so a failed poll can be
    // in flight with listeners that joined it.
    if (runtime.failNext > 0) {
      runtime.failNext -= 1;
      throw new Error("injected poll failure");
    }
    if (isDown()) throw new Error("connection dropped");
    if (!anchor) runtime.subscribed = true;
    return result;
  };

  const ipcRenderer = {
    invoke: (channel: string, ...args: unknown[]) => {
      const arg = args[0] as { request?: RemoteRuntimeStreamEventsRequest };
      if (channel === IPC.remoteRuntimeStreamEvents) return streamEvents(arg.request ?? {});
      if (channel === IPC.runtimeEventsRelease) {
        runtime.releaseCount += 1;
        runtime.subscribed = false;
        return Promise.resolve({ released: 1 });
      }
      return Promise.resolve(undefined);
    },
  };

  const pumps = createPinnedRuntimeEvents({
    ipcRenderer,
    toWrappedEvent: () => null,
    syncPtyDataSubscriptions: async () => undefined,
    isPtyDataFilteringConfigured: () => false,
  });

  return {
    runtime,
    pumps,
    appendedAt,
    now,
    append: () => {
      runtime.nextId += 1;
      runtime.seq += 1;
      const event: RemoteRuntimeBufferedEvent = {
        id: runtime.nextId,
        timestamp: new Date().toISOString(),
        category: CATEGORY,
        payload: { seq: runtime.seq, epoch: runtime.epoch },
      };
      runtime.events.push(event);
      appendedAt.set(runtime.seq, now());
      // Push delivery follows the subscription: an event reaches every listener
      // as it happens while main holds the subscription, and never otherwise.
      if (runtime.subscribed) {
        pumps.handlePinnedRuntimeEventNotification(PIN.key, runtime.epoch, event);
      }
    },
    restart: (epoch: string) => {
      runtime.epoch = epoch;
      runtime.nextId = 0;
      runtime.events = [];
      runtime.subscribed = false;
    },
    // The connection drops: requests and replies in the window fail, and main's
    // subscription ends with it.
    disconnect: (ms: number) => {
      runtime.downUntilMs = now() + ms;
      runtime.subscribed = false;
    },
    // Main's subscription ends without any error reaching the renderer.
    silentEnd: () => {
      runtime.subscribed = false;
    },
    attach: (suppressReplay: boolean): Listener => {
      const listener: Listener = { attachedAt: now(), deliveries: [], resyncs: [], stop: () => undefined };
      listener.stop = pumps.startPinnedRuntimeEventPump({
        pin: PIN,
        label: "chat",
        suppressReplay,
        dispatch: (event) => {
          listener.deliveries.push([now(), event.id, event.payload]);
        },
        onResync: () => {
          listener.resyncs.push(now());
        },
      });
      return listener;
    },
  };
}

type Rig = ReturnType<typeof createRig>;

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function attachStaggered(rig: Rig, k: number, suppressReplay: boolean): Promise<Listener[]> {
  const listeners: Listener[] = [];
  for (let i = 0; i < k; i += 1) {
    if (i > 0) await advance(STAGGER_MS);
    listeners.push(rig.attach(suppressReplay));
  }
  return listeners;
}

async function drive(
  rig: Rig,
  ms: number,
  every: number,
  actions: Map<number, () => void> = new Map(),
): Promise<void> {
  for (let t = 0; t < ms; t += every) {
    actions.get(t)?.();
    rig.append();
    await advance(every);
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type Outcome = {
  rpcs: number;
  releases: number;
  /** Per-listener delivered ids and payloads in delivery order. */
  sequence: string;
  /** Per-listener set of delivered events, ignoring order and repeats. */
  members: string;
  /** Per-listener [time, id, payload] of each delivery, in delivery order. */
  deliveries: Array<Array<[number, number, unknown]>>;
  /** Per-listener time of each resync. */
  resyncs: number[][];
  /** Append-to-delivery latency over events appended after the listener attached. */
  maxLatencyMs: number;
  meanLatencyMs: number;
};

function finish(rig: Rig, listeners: Listener[]): Outcome {
  let total = 0;
  let count = 0;
  let max = 0;
  for (const listener of listeners) {
    for (const [t, , payload] of listener.deliveries) {
      const seq = (payload as { seq: number }).seq;
      const appended = rig.appendedAt.get(seq);
      if (appended === undefined || appended < listener.attachedAt) continue;
      const latency = t - appended;
      total += latency;
      count += 1;
      max = Math.max(max, latency);
    }
  }
  const outcome: Outcome = {
    rpcs: rig.runtime.rpcCount,
    releases: rig.runtime.releaseCount,
    sequence: hash(
      listeners.map((listener) =>
        listener.deliveries.map(([, id, payload]) => [id, payload]),
      ),
    ),
    members: hash(
      listeners.map((listener) => [
        ...new Set(listener.deliveries.map(([, , payload]) => (payload as { seq: number }).seq)),
      ].sort((a, b) => a - b)),
    ),
    deliveries: listeners.map((listener) => listener.deliveries),
    resyncs: listeners.map((listener) => listener.resyncs),
    maxLatencyMs: max,
    meanLatencyMs: count ? Math.round((total / count) * 100) / 100 : 0,
  };
  for (const listener of listeners) listener.stop();
  return outcome;
}

// K listeners on a quiet pin.
async function runIdle(k: number): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, k, true);
  await advance(60_000);
  return finish(rig, listeners);
}

// K listeners while one event lands every `every` ms: a streaming chat.
async function runStreaming(k: number, every = 20): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, k, true);
  await drive(rig, 9_000, every);
  return finish(rig, listeners);
}

// K listeners open on a runtime that already holds history.
async function runHistory(k: number): Promise<Outcome> {
  const rig = createRig();
  for (let i = 0; i < 1_800; i += 1) rig.append();
  const listeners = await attachStaggered(rig, k, true);
  await drive(rig, 9_000, 20);
  return finish(rig, listeners);
}

// A runtime restart in the middle of a stream, with replaying listeners that
// re-poll from zero and events that land around the restart.
async function runRestart(): Promise<Outcome> {
  const rig = createRig();
  const listeners: Listener[] = [rig.attach(true)];
  await advance(2);
  listeners.push(rig.attach(false));
  await advance(1);
  listeners.push(rig.attach(false));
  await advance(1);
  listeners.push(rig.attach(false));
  for (let t = 0; t < 9_000; t += 1) {
    if (t === 3_000) rig.restart("E2");
    if (t >= 2_990 && t <= 3_030 && t % 3 === 0) rig.append();
    if (t % 20 === 0 && (t < 2_990 || t > 3_030)) rig.append();
    await advance(1);
  }
  return finish(rig, listeners);
}

// Mixed listeners: a replaying one, a leaver, a late joiner, a runtime restart,
// and a gap. Every listener's delivered sequence and timing must match main.
async function runMixed(): Promise<Outcome> {
  const rig = createRig();
  const listeners: Listener[] = [];
  let leaver: Listener | null = null;
  const actions = new Map<number, () => void>([
    [0, () => listeners.push(rig.attach(true))],
    [1, () => listeners.push(rig.attach(false))],
    [2, () => { leaver = rig.attach(true); listeners.push(leaver); }],
    [2_000, () => listeners.push(rig.attach(true))],
    [4_000, () => rig.restart("E2")],
    [5_000, () => { rig.runtime.gapOnNextPoll = true; }],
    [5_500, () => { leaver?.stop(); }],
  ]);
  for (let t = 0; t < 8_000; t += 10) {
    actions.get(t)?.();
    if (t % 50 === 0 && t < 7_000) rig.append();
    await advance(10);
  }
  return finish(rig, listeners);
}

// A burst that lands before the first poll returns, then a late joiner.
async function runBurst(): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, 3, true);
  listeners.push(rig.attach(false));
  for (let i = 0; i < 450; i += 1) rig.append();
  await advance(1_000);
  listeners.push(rig.attach(true));
  await advance(3_000);
  return finish(rig, listeners);
}

// Events that land between the polls of listeners whose timers are out of phase.
async function runBetween(): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, 4, true);
  await drive(rig, 9_000, 7);
  return finish(rig, listeners);
}

// One poll fails while others are sharing it: the failure is that listener's, not the group's.
async function runRejection(): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, 3, true);
  await drive(rig, 9_000, 20, new Map([[3_000, () => { rig.runtime.failNext = 1; }]]));
  return finish(rig, listeners);
}

// The connection drops with a shared poll in flight: it is issued at 5003 and
// answered at 5006, and the drop lands at 5004. Then it comes back 1.5 s later.
async function runReconnect(): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, 3, true);
  await drive(rig, 5_000, 20);
  await advance(2);
  rig.disconnect(1_500);
  await drive(rig, 7_000, 20);
  return finish(rig, listeners);
}

// Main's subscription ends with no error reaching the renderer. Polls keep
// working and sharing stays on: this is the one state the renderer cannot see.
async function runSilentEnd(): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, 3, true);
  await drive(rig, 9_000, 20, new Map([[3_000, () => rig.silentEnd()]]));
  return finish(rig, listeners);
}

// One shared poll fails and main's subscription ends with it, in the same instant.
// Main's other listeners poll outside the failure and re-subscribe at once; the
// joined listeners wait out their 2 s backoff. Known later-delivery case.
async function runRejectionLoss(): Promise<Outcome> {
  const rig = createRig();
  const listeners = await attachStaggered(rig, 3, true);
  await drive(rig, 9_000, 20, new Map([[3_000, () => { rig.runtime.failNext = 1; rig.silentEnd(); }]]));
  return finish(rig, listeners);
}

// Recorded from origin/main at the PR base (cb0f333) with this harness. Each
// deliveries digest covers every listener's [time, id, payload] in delivery order.
type ParityRecord = {
  sequence: string;
  deliveries: string;
  members: string;
  resyncs: number[][];
};
const MAIN_PARITY: Record<string, ParityRecord> = {
  idle: {
    sequence: "4d417efac51835eb0795550275c95bc7001c6e50f0c37e7ff381af198cfb7a8a",
    deliveries: "4d417efac51835eb0795550275c95bc7001c6e50f0c37e7ff381af198cfb7a8a",
    members: "4d417efac51835eb0795550275c95bc7001c6e50f0c37e7ff381af198cfb7a8a",
    resyncs: [[],[],[],[],[],[],[],[],[],[]],
  },
  streaming: {
    sequence: "9daad62837b706bfab9c8026817d304be8148962a90bd1e3c9cdb872072c9fc7",
    deliveries: "7df76a7391e2fe37792b81742f61f8dda80dfd8b63e0d4749964e6fa910dc7cf",
    members: "4580fca421dca4ab32b6948ffe9e811059e81a2dcab3c0a7691612e9a8d4c4d7",
    resyncs: [[],[],[],[],[],[],[],[],[],[]],
  },
  history: {
    sequence: "f680cedfe7060e6f76192fc83c5d561faed2b75fb5d50b3d9a7aef954be78712",
    deliveries: "5aa3dbb1062cdb1674610248c81c25076ff709290fc5b84cf20763662b10b878",
    members: "a03ece960726213f07e8c15895c8e48ff0f8c5a471ce1f761a1c25a673c7c784",
    resyncs: [[],[],[],[],[],[],[],[],[],[]],
  },
  mixed: {
    sequence: "32f45f05a2ef02d47111c4e358b7f8d33c0970b970a86e3f64f38fbbb399dc91",
    deliveries: "48ae0d1d4990338840408ca1bd72ee94e6af57e1689eff9ab88a1c014d5b79c0",
    members: "2d65caa09500c49e8c0e97042cf041982130b7ee94fc43c2f4e938ae7a98ee09",
    resyncs: [[5006],[]],
  },
  burst: {
    sequence: "379177ac2ed90b20beec1292b7b11e820deee7cde5295b5205c3668f1ae59c86",
    deliveries: "61052e71b45bb24317a1f7b599f4d072bd958b56e5525c04fe5e0af2fe0f22b6",
    members: "445091d504bd537800e98bc60d6799308757bf93567ec5568d1c8338629f96aa",
    resyncs: [[],[],[],[],[]],
  },
  between: {
    sequence: "dc558edc89321a256b0cee0e996d80b74e04856111a6d68ea91165c35a7bfb42",
    deliveries: "f705828631b5e1a1afeb5c4c601b2acc729b05eb4308ed10a2a4ed71c806a66e",
    members: "e1f5cfdc350a5e120091c951c76c393624acdc331163d045dd025c77c8a64c7b",
    resyncs: [[],[],[],[]],
  },
  rejection: {
    sequence: "c3f40acf5d410298a3540ab869960c3dae10d556820a63cec24f922faf12df67",
    deliveries: "91b0b366363782a5631561ad760b3bbdbb8dacd33b11d164b466d79e7c05ef62",
    members: "874776a663adfb5bd0abe43d6fb95e2d73a950faaf3f058b1fb48399ca45b422",
    resyncs: [[7009],[],[]],
  },
  reconnect: {
    sequence: "08619d0ec32bbbac75a34d417e084d1b0e446cba6c42c9e5f6e0225b1d84cf2e",
    deliveries: "7abd71a22896178af3a781d6db8d0b012296558cceaf918bf5df8b4b4c6f49b0",
    members: "c362d9f415339801dd8fc151097742369110351ba7d72e5b7911afad1bd46b04",
    resyncs: [[7009],[7010],[7011]],
  },
  silentEnd: {
    sequence: "8b36dab92f5ca5bd2851c93566bd4868979491e36ebcb4f7a0eca05c4b044064",
    deliveries: "fcb4f610ef522eb26b69f9509e514eb5ec03d9ab7464f971dd2cade2387042d5",
    members: "874776a663adfb5bd0abe43d6fb95e2d73a950faaf3f058b1fb48399ca45b422",
    resyncs: [[],[],[]],
  },
  restart: {
    sequence: "33199d9573c77aff751030011faf08e99745cb40be62bf93378d166e10ec708b",
    deliveries: "876f090721c9114776445f9d3450820ac8f78b9a5357b9c5ae9497a0ff97920f",
    members: "e0eb16c060f648f36a8080a9a6e6906535dccf21d75bfdfa17386eb7eeddeb23",
    resyncs: [[5006],[5008],[5009],[5010]],
  },
  rejectionLoss: {
    sequence: "d4eb471888d732f561e56c0952f91c9de94d57d4ab17bd1811efec2ce6fe9ba4",
    deliveries: "93a71c103c78ee9ccd10d56497819b29c05ada365a1a54c6e088a92d43a00b1f",
    members: "874776a663adfb5bd0abe43d6fb95e2d73a950faaf3f058b1fb48399ca45b422",
    resyncs: [[7009],[],[]],
  },
};

// Where main delivers an event later than this preload, the difference is main's
// time minus this preload's, one digit per delivery and one line per listener.
// Every digit is 0-9, so no delivery here is later than main's. Adding the digits
// to this run's times must rebuild main's deliveries digest exactly.
const EARLIER_THAN_MAIN_MS: Record<string, string[]> = {
  reconnect: [
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  ],
  silentEnd: [
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000111111111111111111111111111111111111111111111111110011111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000222222222222222222222222222222222222222222222222220022222222222222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  ],
  restart: [
    "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444440000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  ],
};

// Known deviations, pinned so any change to them shows up.
// Rejection: the joined listeners inherit the failed shared poll and each resyncs
// once. Main's listeners do not resync, since their own polls succeeded.
const REJECTION_RESYNCS = [[7009], [7009], [7009]];
// Rejection with a subscription loss: the joined listeners wait out their 2 s backoff
// while main's other listeners re-subscribe at once. Measured by event id against
// main: 502 deliveries later (100, 201 and 201 on the three listeners), max 2040 ms.
// No delivery is missing, and the delivery order differs on some positions.
const REJECTION_LOSS = {
  sequence: "0820ffcaf5560a24fd41635262b47bee2a64b1e292e15cfc884593835bfa4043",
  deliveries: "380f56ce0391af5d1446d0e568e72814201c94ebb41201fd7776a388c4d4c373",
  resyncs: [[7009],[7009],[7009]],
};

describe("pinned runtime event fan-out", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cuts steady-state polls for extra listeners on one pin", async () => {
    const report: Record<string, unknown> = {};
    for (const k of [1, 5, 10]) {
      report[`idle-K${k}`] = await runIdle(k);
      report[`streaming-K${k}`] = await runStreaming(k);
      report[`history-K${k}`] = await runHistory(k);
    }
    console.log(`PUMP_BENCH ${JSON.stringify(report)}`);
    // Every listener anchors on its own call, so K anchors are the floor. Above
    // that, polls for one pin are shared while the subscription is live. Unshared
    // main sends 120 idle and 80 streaming calls for K=10.
    const idle10 = (report["idle-K10"] as Outcome).rpcs;
    const streaming10 = (report["streaming-K10"] as Outcome).rpcs;
    expect(idle10).toBeLessThanOrEqual(60);
    expect(streaming10).toBeLessThanOrEqual(40);
  });

  it("backs off from a failed shared poll on the schedule its own poll would have", async () => {
    const rig = createRig();
    const listeners = await attachStaggered(rig, 3, true);
    await drive(rig, 9_000, 20, new Map([[3_000, () => { rig.runtime.failNext = 1; }]]));
    const failedAt = rig.runtime.requestAt.find((t) => t >= 3_000);
    expect(failedAt).toBeDefined();
    // The failing poll is answered REPLY_MS after it was sent. The listeners that
    // joined it inherit the failure, so none retries at once: the next request
    // comes 2 s after the failure, as it would for a listener polling alone.
    const next = rig.runtime.requestAt.find((t) => t > (failedAt as number));
    expect(next).toBe((failedAt as number) + REPLY_MS + 2_000);
    finish(rig, listeners);
  });

  it("delivers the same sequence to every listener, and never later than main", async () => {
    const scenarios: Record<string, () => Promise<Outcome>> = {
      idle: () => runIdle(10),
      streaming: () => runStreaming(10),
      history: () => runHistory(10),
      mixed: runMixed,
      burst: runBurst,
      between: runBetween,
      rejection: runRejection,
      reconnect: runReconnect,
      silentEnd: runSilentEnd,
      restart: runRestart,
      rejectionLoss: runRejectionLoss,
    };
    const outcomes: Record<string, Outcome> = {};
    for (const [name, run] of Object.entries(scenarios)) outcomes[name] = await run();
    console.log(
      `PUMP_PARITY ${JSON.stringify(
        Object.fromEntries(
          Object.entries(outcomes).map(([name, o]) => [
            name,
            { sequence: o.sequence, deliveries: hash(o.deliveries), members: o.members, rpcs: o.rpcs },
          ]),
        ),
      )}`,
    );
    for (const name of Object.keys(scenarios)) {
      const main = MAIN_PARITY[name];
      const o = outcomes[name];
      expect(o.members, `${name} delivered events`).toBe(main.members);
      if (name === "rejectionLoss") {
        expect(o.sequence, `${name} sequence (pinned)`).toBe(REJECTION_LOSS.sequence);
        expect(hash(o.deliveries), `${name} deliveries (pinned)`).toBe(REJECTION_LOSS.deliveries);
        expect(o.resyncs, `${name} resyncs (pinned)`).toEqual(REJECTION_LOSS.resyncs);
        continue;
      }
      expect(o.sequence, `${name} sequence`).toBe(main.sequence);
      if (name === "rejection") {
        expect(hash(o.deliveries), `${name} deliveries`).toBe(main.deliveries);
        expect(o.resyncs, `${name} resyncs (pinned)`).toEqual(REJECTION_RESYNCS);
      } else if (name in EARLIER_THAN_MAIN_MS) {
        expectNoLaterThanMain(name, o, main);
      } else {
        expect(hash(o.deliveries), `${name} deliveries`).toBe(main.deliveries);
        expect(o.resyncs, `${name} resyncs`).toEqual(main.resyncs);
      }
    }
  });
});

function expectNoLaterThanMain(name: string, o: Outcome, main: ParityRecord): void {
  expect(o.resyncs.map((l) => l.length), `${name} resync counts`).toEqual(
    main.resyncs.map((l) => l.length),
  );
  o.resyncs.forEach((times, i) =>
    times.forEach((time, j) =>
      expect(time, `${name} resync ${i}.${j}`).toBeLessThanOrEqual(main.resyncs[i][j]),
    ),
  );
  const digits = EARLIER_THAN_MAIN_MS[name];
  expect(o.deliveries.length, `${name} listeners`).toBe(digits.length);
  const onMainClock = o.deliveries.map((listener, i) => {
    expect(listener.length, `${name} listener ${i} deliveries`).toBe(digits[i].length);
    return listener.map(([time, id, payload], j) => [time + Number(digits[i][j]), id, payload]);
  });
  expect(hash(onMainClock), `${name} deliveries against main`).toBe(main.deliveries);
}
