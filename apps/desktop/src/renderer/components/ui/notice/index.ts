/**
 * ADE's notice system. See docs/design/notices.md for which primitive to use.
 *
 * - `Banner` + `useAppBanner` / `AppBannerHost`: banners (docked, floating, inline)
 * - `showToast` (components/app/toast/toastStore) + `ToastCard`: bottom-right toasts
 * - `StatusStrip` + `StatusChip`: one row of small status chips on a composer's edge
 * - `noticeTone`: the shared tone palette
 */
export { Banner, type BannerDismiss, type BannerLayout, type BannerModel } from "./Banner";
export { AppBannerHost } from "./AppBannerHost";
export {
  APP_BANNER_PRIORITY,
  useAppBanner,
  useAppBanners,
  type AppBannerOptions,
  type AppBannerPlacement,
} from "./appBannerStore";
export { ToastCard, type ToastCardAction, type ToastCardModel, type ToastChip } from "./ToastCard";
export {
  NoticeActions,
  NoticeBadge,
  NoticeButton,
  NoticeChip,
  NoticeCloseButton,
  NoticeIcon,
  type NoticeAction,
  type NoticeActionVariant,
} from "./NoticeParts";
export { noticeTone, type NoticeTone, type NoticeToneTokens } from "./noticeTones";
export { StatusChip, StatusStrip, type StatusChipAction } from "./StatusChip";
