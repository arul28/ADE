export type AgentChatAttachmentDropTarget = {
  canHandle: (dataTransfer: DataTransfer) => boolean;
  handle: (dataTransfer: DataTransfer) => void;
};
