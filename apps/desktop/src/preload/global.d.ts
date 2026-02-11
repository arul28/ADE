export {};

declare global {
  interface Window {
    ade: {
      app: {
        ping: () => Promise<"pong">;
        getInfo: () => Promise<{
          appVersion: string;
          isPackaged: boolean;
          platform: NodeJS.Platform;
          arch: string;
          versions: {
            electron: string;
            chrome: string;
            node: string;
            v8: string;
          };
          env: {
            nodeEnv?: string;
            viteDevServerUrl?: string;
          };
        }>;
        getProject: () => Promise<{
          rootPath: string;
          displayName: string;
          baseRef: string;
        }>;
      };
      project: {
        openRepo: () => Promise<{
          rootPath: string;
          displayName: string;
          baseRef: string;
        }>;
        openAdeFolder: () => Promise<void>;
      };
      lanes: {
        list: (args?: { includeArchived?: boolean }) => Promise<
          Array<{
            id: string;
            name: string;
            description?: string | null;
            baseRef: string;
            branchRef: string;
            worktreePath: string;
            status: { dirty: boolean; ahead: number; behind: number };
            createdAt: string;
            archivedAt?: string | null;
          }>
        >;
        create: (args: { name: string; description?: string }) => Promise<{
          id: string;
          name: string;
          description?: string | null;
          baseRef: string;
          branchRef: string;
          worktreePath: string;
          status: { dirty: boolean; ahead: number; behind: number };
          createdAt: string;
          archivedAt?: string | null;
        }>;
        rename: (args: { laneId: string; name: string }) => Promise<void>;
        archive: (args: { laneId: string }) => Promise<void>;
        openFolder: (args: { laneId: string }) => Promise<void>;
      };
      sessions: {
        list: (args?: { laneId?: string; status?: "running" | "completed" | "failed" | "disposed"; limit?: number }) => Promise<
          Array<{
            id: string;
            laneId: string;
            laneName: string;
            ptyId: string | null;
            title: string;
            status: "running" | "completed" | "failed" | "disposed";
            startedAt: string;
            endedAt: string | null;
            exitCode: number | null;
            transcriptPath: string;
            headShaStart: string | null;
            headShaEnd: string | null;
            lastOutputPreview: string | null;
          }>
        >;
        get: (sessionId: string) => Promise<{
          id: string;
          laneId: string;
          laneName: string;
          ptyId: string | null;
          title: string;
          status: "running" | "completed" | "failed" | "disposed";
          startedAt: string;
          endedAt: string | null;
          exitCode: number | null;
          transcriptPath: string;
          headShaStart: string | null;
          headShaEnd: string | null;
          lastOutputPreview: string | null;
        } | null>;
        readTranscriptTail: (args: { sessionId: string; maxBytes?: number }) => Promise<string>;
      };
      pty: {
        create: (args: { laneId: string; cwd?: string; cols: number; rows: number; title: string }) => Promise<{ ptyId: string; sessionId: string }>;
        write: (args: { ptyId: string; data: string }) => Promise<void>;
        resize: (args: { ptyId: string; cols: number; rows: number }) => Promise<void>;
        dispose: (args: { ptyId: string }) => Promise<void>;
        onData: (cb: (ev: { ptyId: string; sessionId: string; data: string }) => void) => () => void;
        onExit: (cb: (ev: { ptyId: string; sessionId: string; exitCode: number | null }) => void) => () => void;
      };
      diff: {
        getChanges: (args: { laneId: string }) => Promise<{
          unstaged: Array<{ path: string; kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown" }>;
          staged: Array<{ path: string; kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown" }>;
        }>;
        getFile: (args: { laneId: string; path: string; mode: "unstaged" | "staged" }) => Promise<{
          path: string;
          mode: "unstaged" | "staged";
          original: { exists: boolean; text: string };
          modified: { exists: boolean; text: string };
          isBinary?: boolean;
          language?: string;
        }>;
      };
      files: {
        writeTextAtomic: (args: { laneId: string; path: string; text: string }) => Promise<void>;
      };
      layout: {
        get: (layoutId: string) => Promise<Record<string, number> | null>;
        set: (layoutId: string, layout: Record<string, number>) => Promise<void>;
      };
    };
  }
}
