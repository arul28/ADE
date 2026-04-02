import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  asTrimmed,
  findHeaderBoundary,
  hasProxyIdentity,
  injectIdentityIntoInitializePayload,
  isRecord,
  parseContentLength,
  takeNextInboundMessage,
  type ProxyIdentity,
} from "./adeMcpProxyUtils";

const NULL_IDENTITY: ProxyIdentity = {
  chatSessionId: null,
  missionId: null,
  runId: null,
  stepId: null,
  attemptId: null,
  ownerId: null,
  role: null,
  computerUsePolicy: null,
};

describe("asTrimmed", () => {
  it("returns trimmed string for valid input", () => {
    expect(asTrimmed("  hello  ")).toBe("hello");
  });

  it("returns the string unchanged when already trimmed", () => {
    expect(asTrimmed("hello")).toBe("hello");
  });

  it("returns null for undefined", () => {
    expect(asTrimmed(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(asTrimmed("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(asTrimmed("   ")).toBeNull();
    expect(asTrimmed("\t\n")).toBeNull();
  });
});

describe("isRecord", () => {
  it("returns true for a plain object", () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("returns true for an empty object", () => {
    expect(isRecord({})).toBe(true);
  });

  it("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it("returns false for an array", () => {
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isRecord("hello")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isRecord(42)).toBe(false);
  });

  it("returns false for a boolean", () => {
    expect(isRecord(true)).toBe(false);
  });
});

describe("hasProxyIdentity", () => {
  it("returns false when all fields are null", () => {
    expect(hasProxyIdentity(NULL_IDENTITY)).toBe(false);
  });

  it("returns true when missionId is set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, missionId: "m-1" })).toBe(true);
  });

  it("returns true when chatSessionId is set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, chatSessionId: "chat-1" })).toBe(true);
  });

  it("returns true when runId is set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, runId: "r-1" })).toBe(true);
  });

  it("returns true when stepId is set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, stepId: "s-1" })).toBe(true);
  });

  it("returns true when attemptId is set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, attemptId: "a-1" })).toBe(true);
  });

  it("returns true when role is set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, role: "coder" })).toBe(true);
  });

  it("returns true when ownerId is set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, ownerId: "agent-1" })).toBe(true);
  });

  it("returns true when computerUsePolicy is set", () => {
    expect(hasProxyIdentity({
      ...NULL_IDENTITY,
      computerUsePolicy: {
        mode: "enabled",
        allowLocalFallback: null,
        retainArtifacts: null,
        preferredBackend: null,
      },
    })).toBe(true);
  });

  it("returns true when multiple fields are set", () => {
    expect(hasProxyIdentity({ ...NULL_IDENTITY, missionId: "m-1", role: "coder" })).toBe(true);
  });
});

describe("findHeaderBoundary", () => {
  it("finds CRLF boundary (\\r\\n\\r\\n)", () => {
    const buf = Buffer.from("Content-Length: 10\r\n\r\n{\"id\":1}");
    const result = findHeaderBoundary(buf);
    expect(result).toEqual({ index: 18, delimiterLength: 4 });
  });

  it("finds LF boundary (\\n\\n)", () => {
    const buf = Buffer.from("Content-Length: 10\n\n{\"id\":1}");
    const result = findHeaderBoundary(buf);
    expect(result).toEqual({ index: 18, delimiterLength: 2 });
  });

  it("picks the earlier boundary when both are present (CRLF first)", () => {
    const buf = Buffer.from("A\r\n\r\nB\n\nC");
    const result = findHeaderBoundary(buf);
    expect(result).toEqual({ index: 1, delimiterLength: 4 });
  });

  it("picks the earlier boundary when both are present (LF first)", () => {
    const buf = Buffer.from("A\n\nB\r\n\r\nC");
    const result = findHeaderBoundary(buf);
    expect(result).toEqual({ index: 1, delimiterLength: 2 });
  });

  it("returns null when no boundary is found", () => {
    const buf = Buffer.from("Content-Length: 10\r\n{\"id\":1}");
    expect(findHeaderBoundary(buf)).toBeNull();
  });

  it("returns null for empty buffer", () => {
    expect(findHeaderBoundary(Buffer.alloc(0))).toBeNull();
  });
});

describe("parseContentLength", () => {
  it("parses valid Content-Length header", () => {
    expect(parseContentLength("Content-Length: 42")).toBe(42);
  });

  it("handles case-insensitive matching", () => {
    expect(parseContentLength("content-length: 99")).toBe(99);
    expect(parseContentLength("CONTENT-LENGTH: 7")).toBe(7);
    expect(parseContentLength("Content-length: 123")).toBe(123);
  });

  it("handles extra whitespace around colon", () => {
    expect(parseContentLength("Content-Length :  55")).toBe(55);
  });

  it("parses from multi-line header block", () => {
    const block = "X-Custom: foo\r\nContent-Length: 128\r\nX-Other: bar";
    expect(parseContentLength(block)).toBe(128);
  });

  it("returns null when header is missing", () => {
    expect(parseContentLength("X-Custom: foo")).toBeNull();
  });

  it("returns null for non-numeric value", () => {
    expect(parseContentLength("Content-Length: abc")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseContentLength("")).toBeNull();
  });
});

describe("takeNextInboundMessage", () => {
  it("parses a JSONL message (starts with {)", () => {
    const json = '{"jsonrpc":"2.0","method":"initialize","id":1}';
    const buf = Buffer.from(json + "\n");
    const result = takeNextInboundMessage(buf);
    expect(result).not.toBeNull();
    expect(result!.transport).toBe("jsonl");
    expect(result!.payloadText).toBe(json);
    expect(result!.rest.length).toBe(0);
  });

  it("parses a JSONL message (starts with [)", () => {
    const json = '[{"jsonrpc":"2.0","id":1}]';
    const buf = Buffer.from(json + "\n");
    const result = takeNextInboundMessage(buf);
    expect(result).not.toBeNull();
    expect(result!.transport).toBe("jsonl");
    expect(result!.payloadText).toBe(json);
  });

  it("returns null for incomplete JSONL (no newline)", () => {
    const buf = Buffer.from('{"jsonrpc":"2.0","id":1}');
    expect(takeNextInboundMessage(buf)).toBeNull();
  });

  it("correctly separates payload from rest in JSONL", () => {
    const msg1 = '{"id":1}\n';
    const msg2 = '{"id":2}\n';
    const buf = Buffer.from(msg1 + msg2);
    const result = takeNextInboundMessage(buf);
    expect(result).not.toBeNull();
    expect(result!.payloadText).toBe('{"id":1}');
    expect(result!.rest.toString("utf8")).toBe(msg2);
  });

  it("parses a framed message with Content-Length header (CRLF)", () => {
    const body = '{"jsonrpc":"2.0","method":"test","id":2}';
    const frame = `Content-Length: ${body.length}\r\n\r\n${body}`;
    const buf = Buffer.from(frame);
    const result = takeNextInboundMessage(buf);
    expect(result).not.toBeNull();
    expect(result!.transport).toBe("framed");
    expect(result!.payloadText).toBe(body);
    expect(result!.rest.length).toBe(0);
  });

  it("parses a framed message with Content-Length header (LF)", () => {
    const body = '{"jsonrpc":"2.0","method":"test","id":3}';
    const frame = `Content-Length: ${body.length}\n\n${body}`;
    const buf = Buffer.from(frame);
    const result = takeNextInboundMessage(buf);
    expect(result).not.toBeNull();
    expect(result!.transport).toBe("framed");
    expect(result!.payloadText).toBe(body);
  });

  it("returns null for empty buffer", () => {
    expect(takeNextInboundMessage(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for incomplete framed message (body too short)", () => {
    const frame = "Content-Length: 100\r\n\r\nshort";
    const buf = Buffer.from(frame);
    expect(takeNextInboundMessage(buf)).toBeNull();
  });

  it("returns null for framed message with missing Content-Length", () => {
    const frame = "X-Other: value\r\n\r\n{\"id\":1}";
    const buf = Buffer.from(frame);
    expect(takeNextInboundMessage(buf)).toBeNull();
  });

  it("correctly separates payload from rest in framed messages", () => {
    const body1 = '{"id":1}';
    const body2 = '{"id":2}';
    const frame1 = `Content-Length: ${body1.length}\r\n\r\n${body1}`;
    const frame2 = `Content-Length: ${body2.length}\r\n\r\n${body2}`;
    const buf = Buffer.from(frame1 + frame2);
    const result = takeNextInboundMessage(buf);
    expect(result).not.toBeNull();
    expect(result!.payloadText).toBe(body1);
    expect(result!.rest.toString("utf8")).toBe(frame2);
  });
});

describe("injectIdentityIntoInitializePayload", () => {
  const identity: ProxyIdentity = {
    chatSessionId: "chat-1",
    missionId: "m-1",
    runId: "r-1",
    stepId: "s-1",
    attemptId: "a-1",
    ownerId: "agent-1",
    role: "coder",
    computerUsePolicy: {
      mode: "enabled",
      allowLocalFallback: true,
      retainArtifacts: false,
      preferredBackend: "vnc",
    },
  };

  it("injects identity into initialize method", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {},
    });
    const result = JSON.parse(injectIdentityIntoInitializePayload(payload, identity));
    expect(result.params.identity).toEqual({
      chatSessionId: "chat-1",
      missionId: "m-1",
      runId: "r-1",
      stepId: "s-1",
      attemptId: "a-1",
      ownerId: "agent-1",
      role: "coder",
      computerUsePolicy: {
        mode: "enabled",
        allowLocalFallback: true,
        retainArtifacts: false,
        preferredBackend: "vnc",
      },
    });
  });

  it("does NOT modify non-initialize methods", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 2,
      params: {},
    });
    const result = injectIdentityIntoInitializePayload(payload, identity);
    expect(result).toBe(payload);
  });

  it("merges with existing identity without overwriting existing fields", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        identity: {
          chatSessionId: "existing-chat",
          missionId: "existing-mission",
          ownerId: "existing-owner",
          role: "existing-role",
          computerUsePolicy: {
            mode: "off",
          },
        },
      },
    });
    const result = JSON.parse(injectIdentityIntoInitializePayload(payload, identity));
    expect(result.params.identity.chatSessionId).toBe("existing-chat");
    expect(result.params.identity.missionId).toBe("existing-mission");
    expect(result.params.identity.ownerId).toBe("existing-owner");
    expect(result.params.identity.role).toBe("existing-role");
    expect(result.params.identity.runId).toBe("r-1");
    expect(result.params.identity.stepId).toBe("s-1");
    expect(result.params.identity.attemptId).toBe("a-1");
    expect(result.params.identity.computerUsePolicy).toEqual({
      mode: "off",
      allowLocalFallback: true,
      retainArtifacts: false,
      preferredBackend: "vnc",
    });
  });

  it("overwrites existing identity fields that are empty strings", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        identity: {
          chatSessionId: "   ",
          missionId: "   ",
          ownerId: "",
          role: "",
        },
      },
    });
    const result = JSON.parse(injectIdentityIntoInitializePayload(payload, identity));
    expect(result.params.identity.chatSessionId).toBe("chat-1");
    expect(result.params.identity.missionId).toBe("m-1");
    expect(result.params.identity.ownerId).toBe("agent-1");
    expect(result.params.identity.role).toBe("coder");
  });

  it("returns original text for invalid JSON", () => {
    const broken = "this is not json {{{";
    expect(injectIdentityIntoInitializePayload(broken, identity)).toBe(broken);
  });

  it("returns original text when identity has no fields set", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {},
    });
    expect(injectIdentityIntoInitializePayload(payload, NULL_IDENTITY)).toBe(payload);
  });

  it("returns original text when payload is not an object", () => {
    expect(injectIdentityIntoInitializePayload('"just a string"', identity)).toBe('"just a string"');
  });

  it("creates params object when params is missing", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
    });
    const result = JSON.parse(injectIdentityIntoInitializePayload(payload, identity));
    expect(result.params.identity).toEqual({
      chatSessionId: "chat-1",
      missionId: "m-1",
      runId: "r-1",
      stepId: "s-1",
      attemptId: "a-1",
      ownerId: "agent-1",
      role: "coder",
      computerUsePolicy: {
        mode: "enabled",
        allowLocalFallback: true,
        retainArtifacts: false,
        preferredBackend: "vnc",
      },
    });
  });

  it("preserves other params fields alongside identity", () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        capabilities: { tools: true },
      },
    });
    const result = JSON.parse(injectIdentityIntoInitializePayload(payload, identity));
    expect(result.params.capabilities).toEqual({ tools: true });
    expect(result.params.identity.chatSessionId).toBe("chat-1");
    expect(result.params.identity.missionId).toBe("m-1");
  });
});
