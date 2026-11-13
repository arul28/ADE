/**
 * Sends a text through the Messages app with AppleScript.
 *
 * The recipient and body are passed as `osascript` run arguments, never
 * interpolated into AppleScript source: a text body is arbitrary user input
 * ("\" & do shell script ... & \""), and building the script by concatenation
 * would turn it into code. `execFile` also avoids a shell entirely.
 *
 * The first send raises macOS's Automation consent for controlling Messages.
 * A denial is reported as `needs_automation_permission` so the Settings surface
 * can send the person to the right pane. Message text and phone numbers are
 * never logged, returned in an error, or included in telemetry.
 *
 * @module messages/messagesSend
 */
import { execFile } from "node:child_process";

export type MessagesSendService = "auto" | "iMessage" | "SMS";

export type SendMessageInput = {
  /** Phone number or email. */
  readonly to: string;
  readonly text: string;
  /**
   * `auto` (default) tries iMessage first and falls back to SMS; `iMessage` and
   * `SMS` pin one account.
   */
  readonly service?: MessagesSendService;
};

export type SendMessageFailureCode =
  | "needs_automation_permission"
  | "unsupported_platform"
  | "error";

export type SendMessageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SendMessageFailureCode; readonly message: string };

/**
 * AppleScript that sends `item 2 of argv` to the participant in `item 1`.
 * Each line is passed with its own `-e`, and the values arrive after `--`.
 */
function sendScript(service: "iMessage" | "SMS"): string[] {
  return [
    "on run argv",
    '  tell application "Messages"',
    `    set targetAccount to first account whose service type is ${service}`,
    "    send (item 2 of argv) to participant (item 1 of argv) of targetAccount",
    "  end tell",
    "end run",
  ];
}

const AUTOMATION_DENIAL_PATTERNS: readonly RegExp[] = [
  /not authorized to send apple events/i,
  /not allowed to send apple events/i,
  /erraeeventnotpermitted/i,
  /\(-1743\)/,
];

function isAutomationDenial(stderr: string): boolean {
  return AUTOMATION_DENIAL_PATTERNS.some((pattern) => pattern.test(stderr));
}

function failure(code: SendMessageFailureCode, message: string): SendMessageResult {
  return { ok: false, code, message };
}

/** Runs one AppleScript account attempt. Never includes the text in an error. */
function sendWithAccount(
  service: "iMessage" | "SMS",
  to: string,
  text: string,
): Promise<SendMessageResult> {
  return new Promise((resolve) => {
    const args = [
      ...sendScript(service).flatMap((line) => ["-e", line]),
      "--",
      to,
      text,
    ];
    execFile(
      "/usr/bin/osascript",
      args,
      { maxBuffer: 64 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ ok: true });
          return;
        }
        if (isAutomationDenial(stderr)) {
          resolve(failure(
            "needs_automation_permission",
            "ADE needs permission to control Messages.",
          ));
          return;
        }
        // The raw stderr can quote the recipient or the body. It stays here.
        resolve(failure("error", "Messages could not send that text."));
      },
    );
  });
}

/**
 * Sends one text. Defaults to `service: "auto"`: iMessage first, then the SMS
 * account. A TCC denial is not retried — the same prompt covers both accounts.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  if (process.platform !== "darwin") {
    return failure("unsupported_platform", "Messages is available on Macs only.");
  }

  const to = input.to.trim();
  const text = input.text;
  if (to === "" || text === "") {
    return failure("error", "A text needs a recipient (phone number or email) and a message.");
  }

  const service = input.service ?? "auto";
  if (service === "iMessage" || service === "SMS") {
    return await sendWithAccount(service, to, text);
  }

  const iMessageResult = await sendWithAccount("iMessage", to, text);
  if (iMessageResult.ok || iMessageResult.code === "needs_automation_permission") {
    return iMessageResult;
  }
  return await sendWithAccount("SMS", to, text);
}
