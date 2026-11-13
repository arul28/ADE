import { ADE_BANNER } from "./banner";

/** `ade devices --help`. See docs/features/sync-and-multi-device/devices-and-machines.md. */
export const DEVICES_HELP = `${ADE_BANNER}
  ADE devices

  A device is something an agent drives and watches: an iPhone simulator, an
  Android emulator, a screen (Mac, Windows or Linux Desktop), an app under App
  Control. Its source is where it runs: here (this machine) or another machine
  on your ADE account. A device id is <kind>@<source>: ios@here,
  "ios@MacBook Pro", "android@Windows PC", screen@build-box. Kinds: ios,
  android, screen, app.

    $ ade devices --text                       Every device this chat can use, on every machine
    $ ade devices --kind ios --text            Only iPhones
    $ ade devices use "ios@MacBook Pro"        This chat's iPhone is on the MacBook from now on
    $ ade devices use ios@here                 Back to this machine
    $ ade devices current --text               This chat's choices

  The list reads only: it starts and copies nothing. Each row says what the
  device is, its state (off, on, in use by a chat) and what it needs first
  ("Android SDK missing there", "repository missing there: --clone").
  A machine that did not answer is a row saying so. A machine that cannot run
  a kind is not listed for it (iPhone simulators run on a Mac).

  After use, the plain commands go there with no other flag: ade apple
  launch, ade apple screenshot, ade android tap, ade screen open, ade
  app-control launch all act on that machine's device, and a build sends your
  code there first. --machine <name> on one command, or --lane, still wins.
  The choice is kept by this chat (it survives a restart of ADE). ade shell
  does not follow it: a command on another machine always names --machine.
  use needs a chat; a terminal with no chat names --machine on each command.
`;
