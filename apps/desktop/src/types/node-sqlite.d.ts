declare module "node:sqlite" {
  export type StatementResultingChanges = {
    changes: number;
    lastInsertRowid: number | bigint;
  };

  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...params: unknown[]): T[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { allowExtension?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    enableLoadExtension(allow: boolean): void;
    loadExtension(path: string): void;
  }
}
