import { useState } from "react";
import { useLocation } from "react-router-dom";
import { DidYouKnow } from "./DidYouKnow";
import { WelcomeVideoGate } from "./WelcomeVideoGate";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";

export function OnboardingBootstrap() {
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeChecking, setWelcomeChecking] = useState(true);
  const location = useLocation();
  const showWelcome = useAppStore((state) => state.showWelcome);
  // The desktop first-run onboarding (welcome video, "get it on your phone",
  // did-you-know tips) is desktop-specific and would cover the web-client shell
  // chrome; the browser client has its own pairing/onboarding surface.
  if (isWebClientMode()) return null;
  // The did-you-know toast is a fixed bottom-right portal that overlaps the
  // projectless chats composer at narrow widths; suppress it on that surface.
  const suppressTips = showWelcome && location.pathname.startsWith("/chats");
  return (
    <>
      <WelcomeVideoGate
        onVisibilityChange={(visible, checking) => {
          setWelcomeVisible(visible);
          setWelcomeChecking(checking);
        }}
      />
      {!welcomeVisible && !welcomeChecking && !suppressTips ? <DidYouKnow /> : null}
    </>
  );
}
