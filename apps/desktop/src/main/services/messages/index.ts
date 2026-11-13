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
export { decodeAttributedBody } from "./attributedBody";
export { extractSignInCode, type ExtractedSignInCode } from "./messageCodes";
export {
  appleMessageDateToIso,
  checkMessagesDatabaseAccess,
  defaultMessagesDatabasePath,
  handlesMatch,
  isFullDiskAccessDenial,
  listChats,
  normalizeHandle,
  openMessagesDatabase,
  readRecentMessages,
  type ChatRecord,
  type ListChatsOptions,
  type MessageAttachment,
  type MessageRecord,
  type MessageService,
  type MessagesAccessFailure,
  type MessagesAccessResult,
  type ReadRecentMessagesOptions,
} from "./messagesDatabase";
export {
  MESSAGES_READ_WORKER_TIMEOUT_MS,
  readMessagesInWorker,
  terminateMessagesReadWorkers,
  type MessagesReadFailureCode,
  type MessagesReadRequest,
  type MessagesReadResponse,
  type MessagesReadWorkerOptions,
} from "./messagesReadWorkerClient";
export {
  sendMessage,
  type MessagesSendService,
  type SendMessageFailureCode,
  type SendMessageInput,
  type SendMessageResult,
} from "./messagesSend";
