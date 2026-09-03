/**
 * `@ade-dev/ui/attachments` — the composer's attachment chips. Pulls
 * `@phosphor-icons/react`, so it stays out of the barrel.
 */

export {
  AttachmentTray,
  CHAT_IMAGE_ATTACHMENT_FOCUS_SELECTOR,
  FileAttachmentChip,
  ImageAttachmentPreview,
  ImageUrlAttachmentChip,
  IssueAttachmentChip,
  OrchestrationAnnotationChip,
  PendingImageAttachmentPreview,
  attachmentChipTone,
  attachmentName,
  focusAdjacentImageAttachment,
  handleImageAttachmentKeyDown,
  middleTruncateFilename,
} from "./AttachmentTray";
export type { IssueAttachmentBrand } from "./AttachmentTray";
