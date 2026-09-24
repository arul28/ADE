/**
 * ADE's notice system. See docs/design/notices.md for which primitive to use.
 *
 * - `Banner` + `useAppBanner` / `AppBannerHost`: banners (docked, floating, inline)
 * - `showToast` (components/app/toast/toastStore) + `ToastCard`: bottom-right toasts
 * - `noticeTone`: the shared tone palette
 */
export { Banner, isDurableDismiss, type BannerDismiss, type BannerLayout, type BannerModel } from "./Banner";
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
  defaultNoticeIcon,
  type NoticeAction,
  type NoticeActionVariant,
} from "./NoticeParts";
export { NOTICE_TONE_RANK, noticeTone, type NoticeTone, type NoticeToneTokens } from "./noticeTones";
