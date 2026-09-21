import { describe, expect, it } from "vitest";

import {
  armIfStale,
  newStagedSection,
  resetStagedSection,
  suppressStagedSection,
  providerThreadContinuityChanged,
  providerThreadRef,
  UNOPENED_PROVIDER_THREAD_REF,
  type ThreadPointerFields,
} from "./providerThreadContinuity";

/**
 * Two ~10-20 KB sections of a CTO turn ride only a provider thread that has not
 * already heard them, so the thread's identity has to be right for EVERY
 * adapter. The bug this pins: a hand-rolled switch that covered claude, droid,
 * cursor-sdk, opencode and acp sent codex and pi to a `null` default, never read
 * `cursorCloudAgentId`, and never folded `unified` onto opencode — so those
 * chats sat on a permanent `<provider>:none`, which reads as "unchanged"
 * against itself and left the tail and the static block staged forever.
 */

/** One adapter: the fields it keeps its pointer in, and two real thread ids. */
const ADAPTERS: Array<{
  name: string;
  first: ThreadPointerFields;
  rotated: ThreadPointerFields;
  /** What the ref reads as before the thread is opened. */
  unopened: ThreadPointerFields;
  expectedProvider: string;
}> = [
  {
    name: "codex",
    first: { provider: "codex", threadId: "thread-1" },
    rotated: { provider: "codex", threadId: "thread-2" },
    unopened: { provider: "codex" },
    expectedProvider: "codex",
  },
  {
    name: "claude",
    first: { provider: "claude", sdkSessionId: "sdk-1" },
    rotated: { provider: "claude", sdkSessionId: "sdk-2" },
    unopened: { provider: "claude" },
    expectedProvider: "claude",
  },
  {
    name: "cursor sdk",
    first: { provider: "cursor", cursorSdkAgentId: "agent-1" },
    rotated: { provider: "cursor", cursorSdkAgentId: "agent-2" },
    unopened: { provider: "cursor" },
    expectedProvider: "cursor",
  },
  {
    name: "cursor cloud",
    first: { provider: "cursor", cursorCloudAgentId: "cloud-1" },
    rotated: { provider: "cursor", cursorCloudAgentId: "cloud-2" },
    unopened: { provider: "cursor" },
    expectedProvider: "cursor",
  },
  {
    name: "pi",
    first: { provider: "pi", piSessionId: "pi-1" },
    rotated: { provider: "pi", piSessionId: "pi-2" },
    unopened: { provider: "pi" },
    expectedProvider: "pi",
  },
  {
    name: "opencode",
    first: { provider: "opencode", providerSessionId: "oc-1" },
    rotated: { provider: "opencode", providerSessionId: "oc-2" },
    unopened: { provider: "opencode" },
    expectedProvider: "opencode",
  },
  {
    name: "unified (folds onto opencode)",
    first: { provider: "unified", providerSessionId: "oc-1" },
    rotated: { provider: "unified", providerSessionId: "oc-2" },
    unopened: { provider: "unified" },
    expectedProvider: "opencode",
  },
  {
    name: "droid",
    first: { provider: "droid", droidSdkSessionId: "droid-1" },
    rotated: { provider: "droid", droidSdkSessionId: "droid-2" },
    unopened: { provider: "droid" },
    expectedProvider: "droid",
  },
  {
    name: "acp (qwen)",
    first: { provider: "qwen", acpSessionId: "acp-1" },
    rotated: { provider: "qwen", acpSessionId: "acp-2" },
    unopened: { provider: "qwen" },
    expectedProvider: "qwen",
  },
];

describe("providerThreadRef", () => {
  for (const adapter of ADAPTERS) {
    it(`reads the thread pointer for ${adapter.name}`, () => {
      const opened = providerThreadRef(adapter.first);
      expect(opened.provider).toBe(adapter.expectedProvider);
      expect(opened.ref).not.toBe(UNOPENED_PROVIDER_THREAD_REF);
      expect(providerThreadRef(adapter.unopened).ref).toBe(UNOPENED_PROVIDER_THREAD_REF);
    });
  }

  it("prefers the cursor SDK agent over the cloud agent, and falls back to it", () => {
    expect(providerThreadRef({
      provider: "cursor",
      cursorSdkAgentId: "agent-1",
      cursorCloudAgentId: "cloud-1",
    }).ref).toBe("agent-1");
    expect(providerThreadRef({ provider: "cursor", cursorCloudAgentId: "cloud-1" }).ref).toBe("cloud-1");
  });

  it("falls back to pi's session file when the session id is not written yet", () => {
    expect(providerThreadRef({ provider: "pi", piSessionFile: "/tmp/pi.jsonl" }).ref).toBe("/tmp/pi.jsonl");
  });
});

describe("a rotation re-arms both staged sections, and opening a thread does not", () => {
  /** The two staged sections, driven exactly as `refreshReconstructionContext` drives them. */
  const stageTurn = (
    sections: { tail: ReturnType<typeof newStagedSection>; staticBlock: ReturnType<typeof newStagedSection> },
    pointers: ThreadPointerFields,
    contentKey = "prompt-v1",
  ): void => {
    const key = providerThreadRef(pointers);
    armIfStale(sections.tail, key);
    armIfStale(sections.staticBlock, key, contentKey);
  };

  /** A send that carried both sections whole. */
  const deliver = (sections: { tail: ReturnType<typeof newStagedSection>; staticBlock: ReturnType<typeof newStagedSection> }): void => {
    sections.tail.pending = false;
    sections.staticBlock.pending = false;
  };

  for (const adapter of ADAPTERS) {
    it(`re-stages the tail and the static block on a ${adapter.name} rotation`, () => {
      const sections = { tail: newStagedSection(), staticBlock: newStagedSection() };

      // Turn one is prepared before the runtime exists, so the ref is `none`.
      stageTurn(sections, adapter.unopened);
      expect(sections.tail.pending).toBe(true);
      expect(sections.staticBlock.pending).toBe(true);
      deliver(sections);

      // Turn two sees the id the thread just learned. That is the SAME thread —
      // it received turn one's prefix — so nothing re-stages.
      stageTurn(sections, adapter.first);
      expect(sections.tail.pending).toBe(false);
      expect(sections.staticBlock.pending).toBe(false);

      // Turn three talks to a thread that has been told nothing.
      stageTurn(sections, adapter.rotated);
      expect(sections.tail.pending).toBe(true);
      expect(sections.staticBlock.pending).toBe(true);
    });
  }

  it("re-stages on a provider switch even when the new thread has no id yet", () => {
    const sections = { tail: newStagedSection(), staticBlock: newStagedSection() };
    stageTurn(sections, { provider: "claude", sdkSessionId: "sdk-1" });
    deliver(sections);
    stageTurn(sections, { provider: "codex" });
    expect(sections.tail.pending).toBe(true);
    expect(sections.staticBlock.pending).toBe(true);
  });

  it("re-stages only the static block when the prompt changes under a live thread", () => {
    const sections = { tail: newStagedSection(), staticBlock: newStagedSection() };
    stageTurn(sections, { provider: "claude", sdkSessionId: "sdk-1" });
    deliver(sections);

    // An identity rename or an edited prompt extension. The thread is intact,
    // so the tail is still nothing the model needs.
    stageTurn(sections, { provider: "claude", sdkSessionId: "sdk-1" }, "prompt-v2");
    expect(sections.staticBlock.pending).toBe(true);
    expect(sections.tail.pending).toBe(false);
  });

  it("stays armed across the several rebuilds a single turn performs", () => {
    const sections = { tail: newStagedSection(), staticBlock: newStagedSection() };
    stageTurn(sections, { provider: "codex", threadId: "thread-1" });
    // Nothing consumed it; a later rebuild of the same turn must not disarm it.
    stageTurn(sections, { provider: "codex", threadId: "thread-1" });
    expect(sections.tail.pending).toBe(true);
    expect(sections.staticBlock.pending).toBe(true);
  });
});

describe("a reset forgets the thread a section was staged for", () => {
  it("re-arms a section whose thread was reset under the same runtime handle", () => {
    const runtime = { kind: "claude" };
    const staged = newStagedSection();
    armIfStale(staged, providerThreadRef({ provider: "claude", sdkSessionId: "sdk-1" }, runtime));
    staged.pending = false;

    // The provider threw the conversation away and named a new one, but the
    // runtime object — the thread's identity of last resort — is the same, so
    // nothing `armIfStale` looks at has moved.
    armIfStale(staged, providerThreadRef({ provider: "claude", sdkSessionId: "sdk-2" }, runtime));
    expect(staged.pending).toBe(false);

    resetStagedSection(staged);
    expect(staged.pending).toBe(true);
    expect(staged.threadKey).toBeNull();
    expect(staged.contentKey).toBeNull();
  });

  it("stands a section down without sending it", () => {
    const staged = newStagedSection();
    resetStagedSection(staged);
    suppressStagedSection(staged);
    expect(staged.pending).toBe(false);
  });
});

describe("providerThreadContinuityChanged", () => {
  it("treats a first look as a change and an unchanged ref as no change", () => {
    const key = providerThreadRef({ provider: "codex", threadId: "thread-1" });
    expect(providerThreadContinuityChanged(null, key)).toBe(true);
    expect(providerThreadContinuityChanged(key, key)).toBe(false);
  });

  it("treats `none` as unknown rather than as a different thread", () => {
    const unopened = providerThreadRef({ provider: "codex" });
    const opened = providerThreadRef({ provider: "codex", threadId: "thread-1" });
    // A thread learning its own name.
    expect(providerThreadContinuityChanged(unopened, opened)).toBe(false);
    // A runtime that is not up right now says nothing about the next thread.
    expect(providerThreadContinuityChanged(opened, unopened)).toBe(false);
    // A provider change is a change either way.
    expect(providerThreadContinuityChanged(opened, providerThreadRef({ provider: "claude" }))).toBe(true);
  });

  it("does not forget the thread a section was staged for when the runtime goes down", () => {
    const staged = newStagedSection();
    armIfStale(staged, providerThreadRef({ provider: "claude", sdkSessionId: "sdk-1" }));
    staged.pending = false;
    // The runtime is torn down between turns: the pointer lives only in it.
    armIfStale(staged, providerThreadRef({ provider: "claude" }));
    expect(staged.pending).toBe(false);
    expect(staged.threadKey?.ref).toBe("sdk-1");
    // The resume opens a different SDK session, which must be caught.
    armIfStale(staged, providerThreadRef({ provider: "claude", sdkSessionId: "sdk-2" }));
    expect(staged.pending).toBe(true);
  });
});
