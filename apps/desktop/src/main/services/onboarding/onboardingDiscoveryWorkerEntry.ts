import { runOnboardingDiscoveryWorkerEntrypoint } from "./onboardingDiscoveryWorker";

// Exit as soon as the answer is written: a provider reader that leaves a handle
// open must not keep the child alive.
void runOnboardingDiscoveryWorkerEntrypoint().then((exitCode) => process.exit(exitCode));
