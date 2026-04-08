export type RuntimeTextPart = {
  type: "text";
  text: string;
};

export type RuntimeImagePart = {
  type: "image";
  image: Uint8Array | Buffer;
  mediaType: string;
};

export type RuntimeFilePart = {
  type: "file";
  data: Uint8Array | Buffer;
  filename?: string;
  mediaType: string;
};

export type RuntimeUserContent =
  | string
  | Array<RuntimeTextPart | RuntimeImagePart | RuntimeFilePart>;

export type RuntimeModelMessage = {
  role: "user" | "assistant";
  content: RuntimeUserContent;
};
