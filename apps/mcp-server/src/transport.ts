import net from "node:net";

export type JsonRpcTransport = {
  onData(callback: (chunk: Buffer) => void): void;
  write(data: string): void;
  close(): void;
};

export function createStdioTransport(): JsonRpcTransport {
  return {
    onData(callback) {
      process.stdin.on("data", callback);
      process.stdin.resume();
    },
    write(data) {
      process.stdout.write(data);
    },
    close() {
      // No-op for stdio — process exits naturally
    }
  };
}

export function createSocketTransport(socketPath: string): Promise<JsonRpcTransport> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      resolve({
        onData(callback) {
          socket.on("data", callback);
        },
        write(data) {
          socket.write(data);
        },
        close() {
          socket.end();
        }
      });
    });
    socket.on("error", reject);
  });
}
