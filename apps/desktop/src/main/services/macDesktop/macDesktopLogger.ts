/**
 * The Mac Desktop service's logger: the project log it was always given, plus
 * the machine log.
 *
 * The service used to receive only the project runtime's logger, which writes
 * `<project>/.ade/transcripts/logs/ade-cli.jsonl`. The driver, its virtual
 * displays and the permissions it probes are facts about this computer, not
 * about whichever project happened to start the helper, and the machine log
 * (`brain.jsonl` in the brain, `desktop-main.jsonl` in the desktop) is where a
 * diagnostic report and a person looking at a failure go first. On the owner's
 * MacBook a display that vanished mid-session left no line in either place.
 */

import type { Logger } from "../logging/logger";

export function createMacDesktopLogger(projectLogger: Logger, machineLogger: Logger | null): Logger {
  if (!machineLogger || machineLogger === projectLogger) return projectLogger;
  return {
    debug: (event, meta) => {
      projectLogger.debug(event, meta);
      machineLogger.debug(event, meta);
    },
    info: (event, meta) => {
      projectLogger.info(event, meta);
      machineLogger.info(event, meta);
    },
    warn: (event, meta) => {
      projectLogger.warn(event, meta);
      machineLogger.warn(event, meta);
    },
    error: (event, meta) => {
      projectLogger.error(event, meta);
      machineLogger.error(event, meta);
    },
  };
}
