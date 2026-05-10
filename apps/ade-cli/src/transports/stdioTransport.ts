import { Buffer } from "node:buffer";
import type { JsonRpcTransport } from "../jsonrpc";

export function createStdioTransport(): JsonRpcTransport {
  return {
    onData(callback) {
      process.stdin.on("data", (chunk) => {
        callback(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    },
    write(data) {
      process.stdout.write(data);
    },
    close() {
      process.stdin.pause();
    },
  };
}
