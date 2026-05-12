import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type Resolver = (value: IteratorResult<SDKUserMessage>) => void;

export class ClaudeInputPump implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private readonly resolvers: Resolver[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error("Cannot push to a closed Claude input pump.");
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: message, done: false });
      return;
    }
    this.buffer.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const resolvers = this.resolvers.splice(0);
    for (const resolver of resolvers) {
      resolver({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.buffer.shift();
        if (message) {
          return Promise.resolve({ value: message, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
