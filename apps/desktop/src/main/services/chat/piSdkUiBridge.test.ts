import { describe, expect, it, vi } from "vitest";
import {
  PI_LOGIN_CANCELLED_MESSAGE,
  createPiApprovalGate,
  createPiAuthInteraction,
  createPiExtensionUiContext,
  createPiUiBridge,
  piAskUserRequestFromArgs,
  piAskUserResultText,
  piApprovalSummary,
  piUiOptionsFromLabels,
  withPiApproval,
  type PiToolDefinitionLike,
} from "./piSdkUiBridge";
import { PI_APPROVAL_ALLOW, PI_APPROVAL_ALLOW_SESSION } from "./piSdkEventMapper";
import type { PiSdkWorkerResponse } from "./piSdkProtocol";

function harness() {
  const sent: PiSdkWorkerResponse[] = [];
  let counter = 0;
  const bridge = createPiUiBridge((message) => sent.push(message), () => `req-${++counter}`);
  const requests = () => sent.filter((message) => message.type === "ui_request") as Array<
    Extract<PiSdkWorkerResponse, { type: "ui_request" }>
  >;
  const notices = () => sent.filter((message) => message.type === "ui_notice") as Array<
    Extract<PiSdkWorkerResponse, { type: "ui_notice" }>
  >;
  return { bridge, sent, requests, notices };
}

describe("createPiUiBridge", () => {
  it("round-trips an answer and stops tracking the request", async () => {
    const { bridge, requests } = harness();
    const pending = bridge.request({ origin: "tool", kind: "text", message: "Which one?" });
    expect(bridge.pendingCount()).toBe(1);

    expect(bridge.resolve(requests()[0]!.requestId, { ok: true, value: "left" })).toBe(true);
    await expect(pending).resolves.toBe("left");
    expect(bridge.pendingCount()).toBe(0);
  });

  it("resolves to null instead of rejecting when the user dismisses the card", async () => {
    const { bridge, requests } = harness();
    const pending = bridge.request({ origin: "tool", kind: "text", message: "Which one?" });
    bridge.resolve(requests()[0]!.requestId, { ok: false });
    await expect(pending).resolves.toBeNull();
  });

  it("ignores a second answer for the same request", async () => {
    const { bridge, requests } = harness();
    const pending = bridge.request({ origin: "tool", kind: "text", message: "Which one?" });
    const requestId = requests()[0]!.requestId;
    bridge.resolve(requestId, { ok: true, value: "first" });
    expect(bridge.resolve(requestId, { ok: true, value: "second" })).toBe(false);
    await expect(pending).resolves.toBe("first");
  });

  it("drains only the requested origin so a cancelled sign-in leaves a tool card alone", async () => {
    const { bridge } = harness();
    const auth = bridge.request({ origin: "auth", kind: "text", message: "code?" });
    const tool = bridge.request({ origin: "tool", kind: "text", message: "which?" });

    bridge.drain("auth");
    await expect(auth).resolves.toBeNull();
    expect(bridge.pendingCount()).toBe(1);

    bridge.drain();
    await expect(tool).resolves.toBeNull();
  });

  it("refuses new requests once closed so teardown cannot hang a Pi callback", async () => {
    const { bridge } = harness();
    const pending = bridge.request({ origin: "tool", kind: "text", message: "which?" });
    bridge.close();
    await expect(pending).resolves.toBeNull();
    await expect(bridge.request({ origin: "tool", kind: "text", message: "again?" })).resolves.toBeNull();
  });

  it("tells the desktop when it settles a request on its own, so the card can close", async () => {
    const { bridge, sent, requests } = harness();
    const controller = new AbortController();
    const pending = bridge.request({ origin: "extension", kind: "text", message: "which?" }, { signal: controller.signal });
    const requestId = requests()[0]!.requestId;
    controller.abort();
    await pending;
    expect(sent.some((message) => message.type === "ui_cancel" && message.requestId === requestId)).toBe(true);
  });

  it("does not echo a cancel for an answer the desktop supplied", async () => {
    const { bridge, sent, requests } = harness();
    const pending = bridge.request({ origin: "tool", kind: "text", message: "which?" });
    bridge.resolve(requests()[0]!.requestId, { ok: true, value: "x" });
    await pending;
    expect(sent.some((message) => message.type === "ui_cancel")).toBe(false);
  });

  it("survives a signal whose listener registration throws", async () => {
    const { bridge } = harness();
    const hostile = {
      aborted: false,
      addEventListener: () => { throw new Error("hostile extension"); },
      removeEventListener: () => undefined,
    };
    await expect(bridge.request({ origin: "extension", kind: "text", message: "x" }, { signal: hostile }))
      .resolves.toBeNull();
    expect(bridge.pendingCount()).toBe(0);
  });

  it("honours an abort signal supplied by the caller", async () => {
    const { bridge } = harness();
    const controller = new AbortController();
    const pending = bridge.request({ origin: "extension", kind: "text", message: "which?" }, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });
});

describe("piUiOptionsFromLabels", () => {
  it("disambiguates duplicate labels while preserving the original value", () => {
    const mapped = piUiOptionsFromLabels(["Yes", "Yes", " padded "]);
    expect(mapped.map((option) => option.label)).toEqual(["Yes", "Yes (2)", "padded"]);
    // Pi expects the exact string it handed in, whitespace included.
    expect(mapped[2]!.original).toBe(" padded ");
  });
});

describe("extension UI context", () => {
  it("returns the extension's own option string for a selection", async () => {
    const { bridge, requests } = harness();
    const ui = createPiExtensionUiContext({ bridge });
    const select = (ui.select as (t: string, o: string[]) => Promise<string | undefined>)("Pick", ["alpha", "beta"]);
    bridge.resolve(requests()[0]!.requestId, { ok: true, value: "1" });
    await expect(select).resolves.toBe("beta");
  });

  it("denies a confirm the user never answered", async () => {
    const { bridge, requests } = harness();
    const ui = createPiExtensionUiContext({ bridge });
    const confirm = (ui.confirm as (t: string, m: string) => Promise<boolean>)("Delete?", "This cannot be undone.");
    bridge.resolve(requests()[0]!.requestId, { ok: false });
    await expect(confirm).resolves.toBe(false);
  });

  it("keeps an editor's document when the user dismisses the card", async () => {
    const { bridge, requests } = harness();
    const ui = createPiExtensionUiContext({ bridge });
    const editing = (ui.editor as (t: string, p?: string) => Promise<string | undefined>)("Edit", "original text");
    expect(requests()[0]!.payload.defaultValue).toBe("original text");
    bridge.resolve(requests()[0]!.requestId, { ok: false });
    // Cancelling an editor means "leave it as it was", not "discard it".
    await expect(editing).resolves.toBe("original text");
  });

  it("warns once per unsupported terminal-only API", () => {
    const { bridge, notices } = harness();
    const onUnsupported = vi.fn();
    const ui = createPiExtensionUiContext({ bridge, onUnsupported });
    (ui.setWidget as () => void)();
    (ui.setWidget as () => void)();
    expect(onUnsupported).toHaveBeenCalledTimes(1);
    expect(notices()).toHaveLength(1);
  });

  it("suppresses a repeated status value but reports a changed one", () => {
    const { bridge, notices } = harness();
    const ui = createPiExtensionUiContext({ bridge });
    const setStatus = ui.setStatus as (key: string, text?: string) => void;
    setStatus("build", "compiling");
    setStatus("build", "compiling");
    setStatus("build", "linking");
    expect(notices().map((notice) => notice.payload.message)).toEqual(["build: compiling", "build: linking"]);
  });

  it("exposes a theme whose helpers return plain text", () => {
    const { bridge } = harness();
    const ui = createPiExtensionUiContext({ bridge });
    const theme = ui.theme as { bold: (text: string) => string };
    expect(theme.bold("hello")).toBe("hello");
  });
});

describe("auth interaction", () => {
  it("answers a select prompt with the option id Pi expects", async () => {
    const { bridge, requests } = harness();
    const interaction = createPiAuthInteraction(bridge, "anthropic");
    const pending = interaction.prompt({
      type: "select",
      message: "How do you want to sign in?",
      options: [{ id: "max", label: "Claude Max" }, { id: "key", label: "API key" }],
    });
    const request = requests()[0]!;
    expect(request.payload.options?.map((option) => option.value)).toEqual(["max", "key"]);
    bridge.resolve(request.requestId, { ok: true, value: "max" });
    await expect(pending).resolves.toBe("max");
  });

  it("rejects when the user cancels, which is how Pi ends a login", async () => {
    const { bridge, requests } = harness();
    const interaction = createPiAuthInteraction(bridge, "anthropic");
    const pending = interaction.prompt({ type: "secret", message: "API key" });
    bridge.resolve(requests()[0]!.requestId, { ok: false });
    await expect(pending).rejects.toThrow(PI_LOGIN_CANCELLED_MESSAGE);
  });

  it("surfaces a device code with the value the user has to type", () => {
    const { bridge, notices } = harness();
    createPiAuthInteraction(bridge, "github-copilot").notify({
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
    const notice = notices()[0]!.payload;
    expect(notice.message).toContain("ABCD-1234");
    expect(notice.detail).toMatchObject({ kind: "device_code", userCode: "ABCD-1234" });
  });
});

describe("approval gating", () => {
  const definition = (execute = vi.fn().mockResolvedValue({ content: [], details: null })): PiToolDefinitionLike => ({
    name: "bash",
    label: "Bash",
    description: "Run a command",
    parameters: {},
    execute,
  });

  it("runs the tool once allowed", async () => {
    const { bridge, requests } = harness();
    const execute = vi.fn().mockResolvedValue({ content: [], details: null });
    const wrapped = withPiApproval(definition(execute), createPiApprovalGate(bridge));
    const call = wrapped.execute("call-1", { command: "ls" }, undefined, undefined, {});
    bridge.resolve(requests()[0]!.requestId, { ok: true, value: PI_APPROVAL_ALLOW });
    await call;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("throws without running the tool when denied, so Pi marks the call failed", async () => {
    const { bridge, requests } = harness();
    const execute = vi.fn();
    const wrapped = withPiApproval(definition(execute), createPiApprovalGate(bridge));
    const call = wrapped.execute("call-1", { command: "rm -rf /" }, undefined, undefined, {});
    bridge.resolve(requests()[0]!.requestId, { ok: false });
    await expect(call).rejects.toThrow(/denied this bash call/iu);
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops asking after the user allows the tool for the session", async () => {
    const { bridge, requests } = harness();
    const execute = vi.fn().mockResolvedValue({ content: [], details: null });
    const wrapped = withPiApproval(definition(execute), createPiApprovalGate(bridge));

    const first = wrapped.execute("call-1", { command: "ls" }, undefined, undefined, {});
    bridge.resolve(requests()[0]!.requestId, { ok: true, value: PI_APPROVAL_ALLOW_SESSION });
    await first;

    await wrapped.execute("call-2", { command: "pwd" }, undefined, undefined, {});
    expect(requests()).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("summarizes a call by its command or path rather than raw JSON", () => {
    expect(piApprovalSummary("bash", { command: "npm test" })).toBe("npm test");
    expect(piApprovalSummary("write", { filePath: "/tmp/a.txt" })).toBe("/tmp/a.txt");
    expect(piApprovalSummary("edit", { unexpected: 1 })).toBe('{"unexpected":1}');
  });
});

describe("ask_user arguments", () => {
  it("builds a select card from options and a text card without them", () => {
    const withOptions = piAskUserRequestFromArgs({
      question: "Which database?",
      header: "Database",
      options: [{ label: "Postgres", description: "Managed" }, { label: "" }],
    });
    expect(withOptions.kind).toBe("select");
    // The blank label is dropped rather than rendering an unpickable choice.
    expect(withOptions.options).toEqual([{ value: "0", label: "Postgres", description: "Managed" }]);
    expect(piAskUserRequestFromArgs({ question: "Why?" }).kind).toBe("text");
  });

  it("reports the chosen label back to the model, and says so when unanswered", () => {
    const request = piAskUserRequestFromArgs({ question: "Which?", options: [{ label: "Postgres" }] });
    expect(piAskUserResultText(request, "0")).toBe("The user answered: Postgres");
    expect(piAskUserResultText(request, null)).toMatch(/did not answer/iu);
  });
});
