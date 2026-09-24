import React from "react";

import { Banner } from "../ui/notice";

import type { CtoVoiceMicrophoneBlockKind } from "../../../shared/types/ctoVoice";
import { ctoMicrophoneSettingsAction, openCtoSettingsPane } from "./ctoMicrophoneFix";

/**
 * The failure line under the CTO header, with the fix beside it.
 *
 * Its own module because it is not part of the button: the button decides WHEN
 * there is something to say, the page decides WHERE it is drawn — never beside
 * the button, which wrapped "Talk" onto a second line — and this decides what
 * it looks like and what can be pressed on it. That last part is why it is a
 * component and not markup inside the page: this is the surface a microphone
 * failure actually lands on, so the button that opens the right OS pane has to
 * be part of it, and has to be testable without standing up the whole CTO page.
 */

/**
 * A failure the page has to draw, and whether it has a settings fix.
 *
 * The kind rides along rather than the sentence alone because a microphone
 * failure reaches this surface far more often than the sheet: the sheet closes
 * as soon as the call goes live, and capture — which is what discovers there is
 * no microphone — is only opened after that. The owner who pressed Talk with no
 * microphone therefore read the sentence here, where there was nothing to press.
 */
export type CtoTalkNotice = {
  message: string;
  /** Set only when the sentence is a microphone verdict with a pane to open. */
  microphone: CtoVoiceMicrophoneBlockKind | null;
};

export function CtoTalkNoticeLine({ notice }: { notice: CtoTalkNotice }) {
  const action = ctoMicrophoneSettingsAction(notice.microphone);
  return (
    <Banner
      layout="inline"
      style={{ margin: "0 16px 8px" }}
      model={{
        id: "cto-talk-notice",
        tone: "warning",
        ariaLabel: notice.message,
        title: <span data-testid="cto-talk-error">{notice.message}</span>,
        actions: action
          ? [{ label: action.label, onClick: () => { void openCtoSettingsPane(action.paneId); } }]
          : undefined,
      }}
    />
  );
}
