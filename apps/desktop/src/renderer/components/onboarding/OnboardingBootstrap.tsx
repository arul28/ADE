import { useState } from "react";
import { DidYouKnow } from "./DidYouKnow";
import { WelcomeVideoGate } from "./WelcomeVideoGate";
import { isWebClientMode } from "../../lib/webClientMode";

export function OnboardingBootstrap() {
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeChecking, setWelcomeChecking] = useState(true);
  // The desktop first-run onboarding (welcome video, "get it on your phone",
  // did-you-know tips) is desktop-specific and would cover the web-client shell
  // chrome; the browser client has its own pairing/onboarding surface.
  if (isWebClientMode()) return null;
  return (
    <>
      <WelcomeVideoGate
        onVisibilityChange={(visible, checking) => {
          setWelcomeVisible(visible);
          setWelcomeChecking(checking);
        }}
      />
      {!welcomeVisible && !welcomeChecking ? <DidYouKnow /> : null}
    </>
  );
}
