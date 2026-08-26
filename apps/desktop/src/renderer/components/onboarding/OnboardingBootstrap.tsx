import { WelcomeVideoGate } from "./WelcomeVideoGate";
import { isWebClientMode } from "../../lib/webClientMode";

export function OnboardingBootstrap() {
  // The desktop first-run onboarding (welcome video) is desktop-specific and
  // would cover the web-client shell chrome; the browser client has its own
  // pairing/onboarding surface.
  if (isWebClientMode()) return null;
  return <WelcomeVideoGate />;
}
