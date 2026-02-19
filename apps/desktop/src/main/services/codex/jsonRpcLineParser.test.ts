import { describe, expect, it } from "vitest";
import { JsonRpcLineParser } from "./jsonRpcLineParser";

describe("JsonRpcLineParser", () => {
  it("parses multiple newline-delimited messages across chunks", () => {
    const parser = new JsonRpcLineParser();

    const first = parser.push('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2');
    expect(first.parseErrors).toEqual([]);
    expect(first.messages).toHaveLength(1);
    expect("method" in first.messages[0] ? first.messages[0].method : "").toBe("initialize");

    const second = parser.push(',"result":{"ok":true}}\n');
    expect(second.parseErrors).toEqual([]);
    expect(second.messages).toHaveLength(1);
    expect("id" in second.messages[0] ? second.messages[0].id : null).toBe(2);
  });

  it("returns parse errors for invalid JSON lines and keeps valid lines", () => {
    const parser = new JsonRpcLineParser();
    const out = parser.push('{"jsonrpc":"2.0","method":"thread/started","params":{}}\nnot-json\n');
    expect(out.messages).toHaveLength(1);
    expect(out.parseErrors.length).toBe(1);
  });

  it("flushes trailing buffered JSON", () => {
    const parser = new JsonRpcLineParser();
    parser.push('{"jsonrpc":"2.0","id":5,"result":{}}');
    const flushed = parser.flush();
    expect(flushed.parseErrors).toEqual([]);
    expect(flushed.messages).toHaveLength(1);
    expect("id" in flushed.messages[0] ? flushed.messages[0].id : null).toBe(5);
  });
});
