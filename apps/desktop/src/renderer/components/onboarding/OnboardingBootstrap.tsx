import { useState } from "react";
import { DidYouKnow } from "./DidYouKnow";
import { WelcomeVideoGate } from "./WelcomeVideoGate";

export function OnboardingBootstrap() {
  const [welcomeVisible, setWelcomeVisible] = useState(false);
  const [welcomeChecking, setWelcomeChecking] = useState(true);
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
