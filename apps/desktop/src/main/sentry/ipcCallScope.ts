/**
 * Whether the code running now belongs to an `ipcMain.handle` call that is
 * still in flight, so `ipcCapture` reports it if it fails.
 *
 * A brain answering such a call leaves the report to the desktop, which knows
 * the IPC channel; a call main makes on its own (a focus reconcile, project
 * recovery, a handoff) is reported by the brain, because nothing else will.
 * Async work keeps the scope it was started in, so a poll or event pump a
 * handler starts would carry it forever; the scope ends when the handler does.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ open: boolean }>();

export async function runInCapturedIpcCall<T>(fn: () => T | Promise<T>): Promise<T> {
  const call = { open: true };
  try {
    return await scope.run(call, fn);
  } finally {
    call.open = false;
  }
}

export function isInCapturedIpcCall(): boolean {
  return scope.getStore()?.open === true;
}

/**
 * The `ade/actions/call` param that tells the brain the desktop reports this
 * call's failure. Spread into the request; absent outside a captured IPC call.
 */
export function callerReportsFailureParam(): { callerReportsFailure?: true } {
  return isInCapturedIpcCall() ? { callerReportsFailure: true } : {};
}
