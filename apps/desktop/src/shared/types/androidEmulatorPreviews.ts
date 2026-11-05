/**
 * The Android emulator contract, P3 Compose previews: Jetpack Compose
 * `@Preview` functions rendered to PNG by Google's Android CLI
 * (`android preview`), with no emulator. Re-exported from
 * `androidEmulator.ts`; import from there.
 */

import type { AndroidLaneArgs } from "./androidEmulator";

/** At most this many previews in one render; name the rest with `fqns`. */
export const ANDROID_COMPOSE_PREVIEW_RENDER_MAX = 24;

export type AndroidComposePreview = {
  /** The function's fully qualified name (`dev.app.ui.GreetingKt.GreetingPreview`). */
  fqn: string;
  /** The `@Preview(name = …)`, when it has one. */
  name: string | null;
  /** The other `@Preview` arguments, as the CLI prints them. */
  params: Record<string, string>;
};

export type AndroidComposePreviewListArgs = AndroidLaneArgs & {
  /** The Gradle module's folder in the lane (`app`, `feature/home`). Default `app`. */
  module?: string | null;
  /** Previews of the modules it depends on too. */
  all?: boolean | null;
};

export type AndroidComposePreviewList = {
  laneId: string;
  module: string;
  previews: AndroidComposePreview[];
};

export type AndroidComposePreviewRenderArgs = AndroidLaneArgs & {
  module?: string | null;
  /** The previews to render; empty renders every one the module has (up to the max). */
  fqns?: string[] | null;
  /** The calling chat: each image is filed in its proof drawer. */
  chatSessionId?: string | null;
  /** False: write the images and file nothing. Default true. */
  proof?: boolean | null;
  /**
   * True: each image also comes back as a `data:` URL, so a window on
   * another machine can show it (the Tools drawer's Previews group).
   */
  inline?: boolean | null;
};

export type AndroidComposePreviewImage = {
  fqn: string;
  name: string | null;
  /** The PNG on the machine that rendered it; null when this preview failed. */
  path: string | null;
  proofArtifactId: string | null;
  /** The PNG as a `data:` URL, when the render asked for `inline` and the file is small enough. */
  dataUrl?: string | null;
  /** Why this preview has no image. */
  error: string | null;
};

export type AndroidComposePreviewRender = {
  laneId: string;
  module: string;
  /** The folder the images are in, under ADE's data folder. */
  outDir: string;
  images: AndroidComposePreviewImage[];
  /** Previews the module has beyond the max, not rendered. */
  skipped: number;
  durationMs: number;
};

export type AndroidEmulatorPreviewServiceApi = {
  listComposePreviews(args: AndroidComposePreviewListArgs): Promise<AndroidComposePreviewList>;
  renderComposePreviews(args: AndroidComposePreviewRenderArgs): Promise<AndroidComposePreviewRender>;
};
