import { ADE_BANNER } from "./banner";
import { BRAND } from "../../../desktop/src/shared/brand";

/** `ade sync help` and `ade help sync`: one page. */
export const SYNC_HELP = `${ADE_BANNER}
  Machine sync

  How this machine's ${BRAND.NAME} brain syncs with your phone, the web client and your
  other machines. Pair a phone with daex brain pin generate.

    $ daex sync status [--include-transfer-readiness] --text
    $ daex sync web [--open] [--no-clipboard]   Print (and copy) the web client pairing link + code
    $ daex sync refresh
    $ daex sync devices --text                  Paired devices
    $ daex sync name <name>                     Name this runtime for easy identification
    $ daex sync name get
    $ daex sync name clear
    $ daex sync security status                 Machine sync security posture (require-DPoP)
    $ daex sync security require-dpop <on|off>
    $ daex sync pair-device --json-stdin        Advanced: authorize pairing through a trusted local/SSH session
`;

/** `ade help doctor`. */
export const DOCTOR_HELP = `${ADE_BANNER}
  ${BRAND.NAME} doctor

  Is ${BRAND.NAME} healthy on this machine: the installed app, the machine brain, the
  CLI on PATH, the socket, and what to do about each problem. Read-only. Run
  it first when the ${BRAND.NAME} environment is unclear.

    $ daex doctor --text                             Check this machine
    $ daex doctor --online --text                    Also check the ${BRAND.NAME} account and relay services
    $ daex health --text                             This project's problems (moved folders, broken lanes, ...)
`;

/** `ade help status`. */
export const STATUS_HELP = `${ADE_BANNER}
  ${BRAND.NAME} status

  Whether the ${BRAND.NAME} brain this CLI talks to answers, and which one it is. For a
  full check of the machine, run daex doctor --text.

    $ daex status --text
`;

/** `ade help settings`. */
export const SETTINGS_HELP = `${ADE_BANNER}
  ${BRAND.NAME} settings

  Find where a ${BRAND.NAME} setting or page is, as a link the chat shows as a chip.
  Changing a setting is the person's, in the app.

    $ daex settings find <words> --text              Matching settings and pages, with links
    $ daex settings actions --text                   Raw settings service actions
`;
