declare module "@opencode-ai/sdk" {
  export type Config = {
    share?: string;
    autoupdate?: boolean;
    snapshot?: boolean;
    provider?: Record<string, any>;
    agent?: Record<string, any>;
  };
  export type Event = any;
  export type FilePartInput = Record<string, unknown>;
  export type TextPartInput = Record<string, unknown>;
  export type OpencodeClient = any;

  export function createOpencodeClient(args: Record<string, unknown>): any;
  export function createOpencodeServer(args: Record<string, unknown>): Promise<{
    url: string;
    close(): void;
  }>;
}
