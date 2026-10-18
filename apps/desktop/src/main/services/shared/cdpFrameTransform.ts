/**
 * Geometry for content drawn inside an iframe, measured over CDP.
 *
 * A page can move, scale, rotate, skew or mirror an <iframe>, so a frame's
 * viewport maps into its parent's viewport by a 2D affine transform:
 *
 *   parent = origin + local.x * xAxis + local.y * yAxis
 *
 * `DOM.getBoxModel` gives the iframe's drawn content quad (top-left, top-right,
 * bottom-right, bottom-left, in the parent's viewport pixels) and its layout
 * size, which is enough to recover that transform.
 */

export type FrameTransform = {
  /** Where the frame's (0, 0) lands in the parent viewport. */
  originX: number;
  originY: number;
  /** Where one frame pixel along x moves in the parent viewport. */
  xAxisX: number;
  xAxisY: number;
  /** Where one frame pixel along y moves in the parent viewport. */
  yAxisX: number;
  yAxisY: number;
};

export type FramePoint = {
  x: number;
  y: number;
};

export type FrameRect = FramePoint & {
  width: number;
  height: number;
};

export type CdpBoxModelResponse = {
  model?: {
    border?: number[];
    content?: number[];
    /** Layout size of the border box, before any CSS transform. */
    width?: number;
    height?: number;
  };
};

export const IDENTITY_FRAME_TRANSFORM: FrameTransform = {
  originX: 0,
  originY: 0,
  xAxisX: 1,
  xAxisY: 0,
  yAxisX: 0,
  yAxisY: 1,
};

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function quadPoint(quad: number[], index: number): FramePoint {
  return { x: finite(quad[index * 2]), y: finite(quad[index * 2 + 1]) };
}

/**
 * The transform from an iframe's viewport to the viewport its <iframe> element
 * is drawn in. The content quad's edges are the drawn axes; their layout
 * lengths come from the border box's layout size scaled by how much of the
 * drawn border quad the content quad covers.
 */
export function frameTransformFromBox(box: CdpBoxModelResponse): FrameTransform {
  const content = box.model?.content;
  if (!Array.isArray(content) || content.length < 8) throw new Error("Unable to measure the iframe.");
  const topLeft = quadPoint(content, 0);
  const topRight = quadPoint(content, 1);
  const bottomLeft = quadPoint(content, 3);
  const drawnContentWidth = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const drawnContentHeight = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);

  const border = box.model?.border;
  const layoutBorderWidth = finite(box.model?.width);
  const layoutBorderHeight = finite(box.model?.height);
  let layoutContentWidth = drawnContentWidth;
  let layoutContentHeight = drawnContentHeight;
  if (Array.isArray(border) && border.length >= 8 && layoutBorderWidth > 0 && layoutBorderHeight > 0) {
    const borderTopLeft = quadPoint(border, 0);
    const borderTopRight = quadPoint(border, 1);
    const borderBottomLeft = quadPoint(border, 3);
    const drawnBorderWidth = Math.hypot(borderTopRight.x - borderTopLeft.x, borderTopRight.y - borderTopLeft.y);
    const drawnBorderHeight = Math.hypot(borderBottomLeft.x - borderTopLeft.x, borderBottomLeft.y - borderTopLeft.y);
    if (drawnBorderWidth > 0) layoutContentWidth = layoutBorderWidth * (drawnContentWidth / drawnBorderWidth);
    if (drawnBorderHeight > 0) layoutContentHeight = layoutBorderHeight * (drawnContentHeight / drawnBorderHeight);
  }
  if (!(layoutContentWidth > 0) || !(layoutContentHeight > 0)) {
    return { ...IDENTITY_FRAME_TRANSFORM, originX: topLeft.x, originY: topLeft.y };
  }
  return {
    originX: topLeft.x,
    originY: topLeft.y,
    xAxisX: (topRight.x - topLeft.x) / layoutContentWidth,
    xAxisY: (topRight.y - topLeft.y) / layoutContentWidth,
    yAxisX: (bottomLeft.x - topLeft.x) / layoutContentHeight,
    yAxisY: (bottomLeft.y - topLeft.y) / layoutContentHeight,
  };
}

/** `outer` after `inner`: a frame inside a frame. */
export function composeFrameTransforms(outer: FrameTransform, inner: FrameTransform): FrameTransform {
  const origin = frameToParentPoint({ x: inner.originX, y: inner.originY }, outer);
  return {
    originX: origin.x,
    originY: origin.y,
    xAxisX: outer.xAxisX * inner.xAxisX + outer.yAxisX * inner.xAxisY,
    xAxisY: outer.xAxisY * inner.xAxisX + outer.yAxisY * inner.xAxisY,
    yAxisX: outer.xAxisX * inner.yAxisX + outer.yAxisX * inner.yAxisY,
    yAxisY: outer.xAxisY * inner.yAxisX + outer.yAxisY * inner.yAxisY,
  };
}

export function frameToParentPoint(point: FramePoint, transform: FrameTransform): FramePoint {
  return {
    x: transform.originX + point.x * transform.xAxisX + point.y * transform.yAxisX,
    y: transform.originY + point.x * transform.xAxisY + point.y * transform.yAxisY,
  };
}

export function parentToFramePoint(point: FramePoint, transform: FrameTransform): FramePoint {
  const determinant = transform.xAxisX * transform.yAxisY - transform.yAxisX * transform.xAxisY;
  if (Math.abs(determinant) < 1e-9) {
    return { x: point.x - transform.originX, y: point.y - transform.originY };
  }
  const dx = point.x - transform.originX;
  const dy = point.y - transform.originY;
  return {
    x: (dx * transform.yAxisY - dy * transform.yAxisX) / determinant,
    y: (dy * transform.xAxisX - dx * transform.xAxisY) / determinant,
  };
}

/** The parent-viewport box that covers a frame-local rectangle (its drawn corners). */
export function frameToParentRect(rect: FrameRect, transform: FrameTransform): FrameRect {
  const corners = [
    frameToParentPoint({ x: rect.x, y: rect.y }, transform),
    frameToParentPoint({ x: rect.x + rect.width, y: rect.y }, transform),
    frameToParentPoint({ x: rect.x, y: rect.y + rect.height }, transform),
    frameToParentPoint({ x: rect.x + rect.width, y: rect.y + rect.height }, transform),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}
