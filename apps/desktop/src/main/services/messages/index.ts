/**
 * Public surface of the macOS Messages core: read, decode, extract codes, send.
 *
 * The reader (`messagesReadWorkerClient`) runs `messagesReadWorkerEntry` as a
 * child of ADE.app so Full Disk Access belongs to ADE and SQLite never blocks
 * the main thread. Sending (`messagesSend`) goes through the Messages app with
 * AppleScript; the text and recipient travel as arguments, never as script
 * source.
 *
 * Privacy: message text, phone numbers, emails and sign-in codes are sensitive.
 * Nothing in this module logs them; callers must keep them out of logs,
 * telemetry and error surfaces as well.
 *
 * @module messages
 */
export type { ChatRecord, MessageRecord, ReadRecentMessagesOptions } from "./messagesDatabase";
export {
  readMessagesInWorker,
  terminateMessagesReadWorkers,
  type MessagesReadRequest,
  type MessagesReadResponse,
} from "./messagesReadWorkerClient";
export { sendMessage, type SendMessageResult } from "./messagesSend";
