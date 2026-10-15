// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { openPptx } from "./pptx";

/**
 * The `.pptx` reader's validation tool, for the same reason as the `.xlsx`
 * suite: a pure parser over untrusted bytes with no surface to click through.
 * Fixtures are the XML shapes PowerPoint writes, packed with `fflate`.
 */

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function pptxZip(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [
    name,
    typeof data === "string" ? strToU8(data) : data,
  ])));
}

function presentationXml(slideIds: Array<{ id: number; rid: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation ${P_NS} ${R_NS}>
  <p:sldIdLst>
    ${slideIds.map((slide) => `<p:sldId id="${slide.id}" r:id="${slide.rid}"/>`).join("\n    ")}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
</p:presentation>`;
}

const PRESENTATION_RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;

/** Title placeholder whose geometry lives ONLY on the layout. */
const LAYOUT_XML = `<?xml version="1.0"?>
<p:sldLayout ${P_NS} ${A_NS} ${R_NS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`;

const SLIDE1_XML = `<?xml version="1.0"?>
<p:sld ${P_NS} ${A_NS} ${R_NS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr anchor="ctr"/><a:p><a:r><a:t>Q4 Business Review</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/>
        <a:p><a:r><a:rPr b="1" sz="2000"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Revenue up 12%</a:t></a:r></a:p>
        <a:p><a:pPr lvl="1"><a:buNone/></a:pPr><a:r><a:t>APAC led growth</a:t></a:r></a:p>
        <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr i="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>Highlighted</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
    <p:pic>
      <p:spPr><a:xfrm><a:off x="914400" y="4572000"/><a:ext cx="1828800" cy="1371600"/></a:xfrm></p:spPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
    </p:pic>
    <p:sp><p:nvSpPr><p:nvPr/><p:cNvPr/></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>No geometry at all</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

const SLIDE1_RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`;

const SLIDE2_XML = `<?xml version="1.0"?>
<p:sld ${P_NS} ${A_NS} ${R_NS}>
  <p:cSld><p:spTree>
    <p:graphicFrame>
      <p:xfrm><a:off x="762000" y="2000000"/><a:ext cx="10668000" cy="1800000"/></p:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tblPr firstRow="1"/>
          <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          <a:tr><a:tc><a:txBody><a:p><a:r><a:t>APAC</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>$4.2M</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
    <p:graphicFrame>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic>
    </p:graphicFrame>
    <p:grpSp/>
  </p:spTree></p:cSld>
</p:sld>`;

const THEME_XML = `<?xml version="1.0"?>
<a:theme ${A_NS} xmlns="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:clrScheme name="Test">
    <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:accent1><a:srgbClr val="00A0FF"/></a:accent1>
  </a:clrScheme></a:themeElements>
</a:theme>`;

function deckFixture(): Uint8Array {
  return pptxZip({
    "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId2" }, { id: 257, rid: "rId1" }]),
    "ppt/_rels/presentation.xml.rels": PRESENTATION_RELS,
    "ppt/theme/theme1.xml": THEME_XML,
    "ppt/slides/slide1.xml": SLIDE1_XML,
    "ppt/slides/_rels/slide1.xml.rels": SLIDE1_RELS,
    "ppt/slides/slide2.xml": SLIDE2_XML,
    "ppt/slideLayouts/slideLayout1.xml": LAYOUT_XML,
    "ppt/media/image1.png": TINY_PNG,
  });
}

describe("openPptx", () => {
  it("orders slides by sldIdLst, not by file number", async () => {
    const deck = await openPptx(deckFixture());
    expect(deck.slides.length).toBe(2);
    // rId2 (slide2) is first in the list, so slide 2 of the file is slide 1 here.
    expect(deck.slides[0]!.shapes.some((shape) => shape.kind === "table")).toBe(true);
  });

  it("resolves a placeholder's geometry from its slide layout", async () => {
    const deck = await openPptx(deckFixture());
    const slide = deck.slides[1]!;
    const title = slide.shapes.find((shape) => shape.kind === "text" && shape.isTitle);
    expect(title).toBeDefined();
    expect(title!.box).toEqual({
      x: 838200 / 12192000,
      y: 365125 / 6858000,
      w: 10515600 / 12192000,
      h: 1325563 / 6858000,
    });
    expect(slide.title).toBe("Q4 Business Review");
  });

  it("keeps explicit geometry, leaves unknown geometry to the flow, and reads runs and bullets", async () => {
    const deck = await openPptx(deckFixture());
    const slide = deck.slides[1]!;
    const body = slide.shapes.find((shape) => shape.kind === "text" && !shape.isTitle && shape.box !== null);
    expect(body).toBeDefined();
    if (body?.kind !== "text") throw new Error("expected a text shape");
    expect(body.anchor).toBe("top");
    const [first, second, third] = body.paragraphs;
    expect(first!.runs[0]).toMatchObject({ text: "Revenue up 12%", bold: true, sizePt: 20, color: "#ff0000" });
    expect(second).toMatchObject({ level: 1, bullet: false });
    // An explicit bullet char is kept; the theme's accent1 resolves to the deck's colour.
    expect(third).toMatchObject({ bullet: true });
    expect(third!.runs[0]!.color).toBe("#00a0ff");
    expect(third!.runs[0]!.italic).toBe(true);

    const floating = slide.shapes.find((shape) => shape.kind === "text" && shape.box === null);
    expect(floating?.kind).toBe("text");
    expect((floating as { paragraphs: unknown[] }).paragraphs.length).toBe(1);
  });

  it("reads tables, counts charts and groups instead of dropping them silently", async () => {
    const deck = await openPptx(deckFixture());
    const slide = deck.slides[0]!;
    const table = slide.shapes.find((shape) => shape.kind === "table");
    expect(table).toBeDefined();
    if (table?.kind !== "table") throw new Error("expected a table");
    expect(table.rows).toEqual([["Region", "Revenue"], ["APAC", "$4.2M"]]);
    expect(table.headerRow).toBe(true);
    expect(slide.notices.charts).toBe(1);
    expect(slide.notices.groups).toBe(1);
    expect(slide.outline).toEqual(["Region Revenue", "APAC $4.2M"]);
  });

  it("resolves a picture's media part and loads it on demand", async () => {
    const deck = await openPptx(deckFixture());
    const slide = deck.slides[1]!;
    const image = slide.shapes.find((shape) => shape.kind === "image");
    expect(image?.kind).toBe("image");
    expect(image!.mediaPath).toBe("ppt/media/image1.png");
    const media = await deck.loadMedia("ppt/media/image1.png");
    expect(media?.mimeType).toBe("image/png");
    expect(media?.bytes).toEqual(TINY_PNG);
    expect(await deck.loadMedia("ppt/media/missing.png")).toBeNull();
  });

  it("refuses a legacy .ppt compound file with the typed reason", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(openPptx(ole)).rejects.toMatchObject({ reason: "encrypted-or-legacy" });
  });
});
