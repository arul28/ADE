import type { Icon } from "@phosphor-icons/react";
import { DeviceLoadingCard } from "../device/DeviceLoadingCard";
import {
  AppleDeviceIPadGlyph,
  AppleDeviceIPhoneGlyph,
  AppleDeviceTvGlyph,
  AppleDeviceVisionGlyph,
  AppleDeviceWatchGlyph,
} from "../ui/appleIcons";
import { describeAppleError } from "./appleErrors";
import type { AppleDeviceFamilyId } from "./appleDeviceFamily";

export type AppleLoadingStage = "starting" | "streaming";

/** Past this the wait stops looking normal, so the card says that it is. */
const APPLE_LOADING_SLOW_AFTER_MS = 60_000;
const APPLE_LOADING_SLOW_SENTENCE =
  "Still booting — the first boot of a simulator can take a minute.";

/**
 * "Installed simulator · {model} · {runtime}", with the parts that exist, or
 * "New device · …" for one the lane is making now.
 *
 * The first words are load-bearing: every device this card can be showing
 * comes from the machine's own installed runtimes, and saying so is what stops
 * the wait reading as a download.
 */
export function appleLoadingSubtitle(
  model: string | null | undefined,
  runtime: string | null | undefined,
  isNew = false,
): string {
  return [isNew ? "New device" : "Installed simulator", model, runtime]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");
}

const FAMILY_GLYPH: Record<AppleDeviceFamilyId, Icon> = {
  iphone: AppleDeviceIPhoneGlyph,
  ipad: AppleDeviceIPadGlyph,
  watch: AppleDeviceWatchGlyph,
  tv: AppleDeviceTvGlyph,
  vision: AppleDeviceVisionGlyph,
  other: AppleDeviceIPhoneGlyph,
};

/**
 * The one screen between pressing Start and seeing the device (§B5): the
 * shared `DeviceLoadingCard` with the device's family glyph, and the copy of
 * round 2, unchanged.
 */
export function AppleDeviceLoadingCard({
  name,
  runtime,
  model,
  family,
  isNew = false,
  stage,
  error,
  onRetry,
}: {
  name: string;
  /** The device is being made now, from an installed runtime. */
  isNew?: boolean;
  runtime: string | null;
  /** The model, when the name is a rename that hides it. */
  model?: string | null;
  family: AppleDeviceFamilyId;
  stage: AppleLoadingStage;
  /** Non-null turns the card into the failure state. */
  error?: unknown;
  onRetry: () => void;
}) {
  return (
    <DeviceLoadingCard
      tool="apple"
      glyph={FAMILY_GLYPH[family] ?? AppleDeviceIPhoneGlyph}
      name={name}
      subtitle={appleLoadingSubtitle(model, runtime, isNew)}
      step={stage === "starting" ? "booting" : "streaming"}
      dataState={stage}
      slowAfterMs={APPLE_LOADING_SLOW_AFTER_MS}
      slowSentence={APPLE_LOADING_SLOW_SENTENCE}
      failure={error != null ? { sentence: describeAppleError(error).sentence, onRetry } : null}
    />
  );
}
