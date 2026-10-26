import "node:sqlite";

// Node's own `node:sqlite` types return rows as `Record<string, SQLOutputValue>`.
// ADE's readers name the row shape they select: `.get<Row>()`, `.all<Row>()`.
declare module "node:sqlite" {
  interface StatementSync {
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...params: unknown[]): T[];
  }
}
