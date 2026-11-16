import { ADE_BANNER } from "./banner";

/** `ade sync help` and `ade help sync`: one page. */
export const SYNC_HELP = `${ADE_BANNER}
  Machine sync

  How this machine's ADE brain syncs with your phone, the web client and your
  other machines. Pair a phone with ade brain pin generate.

    $ ade sync status [--include-transfer-readiness] --text
    $ ade sync web [--open] [--no-clipboard]   Print (and copy) the web client pairing link + code
    $ ade sync refresh
    $ ade sync devices --text                  Paired devices
    $ ade sync name <name>                     Name this runtime for easy identification
    $ ade sync name get
    $ ade sync name clear
    $ ade sync security status                 Machine sync security posture (require-DPoP)
    $ ade sync security require-dpop <on|off>
    $ ade sync pair-device --json-stdin        Advanced: authorize pairing through a trusted local/SSH session
`;

/** `ade help doctor`. */
export const DOCTOR_HELP = `${ADE_BANNER}
  ADE doctor

  Is ADE healthy on this machine: the installed app, the machine brain, the
  CLI on PATH, the socket, and what to do about each problem. Read-only. Run
  it first when the ADE environment is unclear.

    $ ade doctor --text                             Check this machine
    $ ade doctor --online --text                    Also check the ADE account and relay services
    $ ade health --text                             This project's problems (moved folders, broken lanes, ...)
`;

/** `ade help status`. */
export const STATUS_HELP = `${ADE_BANNER}
  ADE status

  Whether the ADE brain this CLI talks to answers, and which one it is. For a
  full check of the machine, run ade doctor --text.

    $ ade status --text
`;

/** `ade help settings`. */
export const SETTINGS_HELP = `${ADE_BANNER}
  ADE settings

  Find where an ADE setting or page is, as a link the chat shows as a chip.
  Changing a setting is the person's, in the app.

    $ ade settings find <words> --text              Matching settings and pages, with links
    $ ade settings actions --text                   Raw settings service actions
`;
