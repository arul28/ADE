import type { PrCheck, PrComment, PrDetailBundle, PrReview, PrStatus } from "./types";

export const EMPTY_PR_DETAIL_BUNDLE: PrDetailBundle = {
  status: null,
  checks: [],
  reviews: [],
  comments: [],
};

export async function settlePrDetailBundle(loaders: {
  status: () => Promise<PrStatus | null>;
  checks: () => Promise<PrCheck[]>;
  reviews: () => Promise<PrReview[]>;
  comments: () => Promise<PrComment[]>;
}): Promise<PrDetailBundle> {
  const [status, checks, reviews, comments] = await Promise.all([
    loaders.status().catch(() => EMPTY_PR_DETAIL_BUNDLE.status),
    loaders.checks().catch(() => EMPTY_PR_DETAIL_BUNDLE.checks),
    loaders.reviews().catch(() => EMPTY_PR_DETAIL_BUNDLE.reviews),
    loaders.comments().catch(() => EMPTY_PR_DETAIL_BUNDLE.comments),
  ]);
  return { status, checks, reviews, comments };
}
