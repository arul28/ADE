// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { OoxmlError, ooxmlFailureMessage } from "./ooxmlError";
import { openOoxmlZip } from "./ooxmlZip";
import { classifyFormatCode, formatExcelSerial, openXlsx, scanSheetXml, SPREADSHEET_PREVIEW_MAX_ROWS } from "./xlsx";
import { openPptx } from "./pptx";

/**
 * The OOXML readers' validation tool. Both readers are pure parsers over
 * untrusted bytes with no UI or CLI surface to click through, so the fixture
 * package IS the way to prove they read — and refuse — real input.
 *
 * Fixtures are assembled from the XML shapes Excel and PowerPoint write;
 * `zipSync` stands in for the Office packager.
 */

function xlsxZip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" />`;

function workbookXml(options: {
  sheets: Array<{ name: string; rid: string; state?: string }>;
  date1904?: boolean;
}): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr${options.date1904 ? ' date1904="1"' : ""}/>
  <sheets>
    ${options.sheets.map((sheet) => `<sheet name="${sheet.name}" sheetId="1" r:id="${sheet.rid}"${sheet.state ? ` state="${sheet.state}"` : ""}/>`).join("\n    ")}
  </sheets>
</workbook>`;
}

function workbookRels(sheets: Array<{ rid: string; target: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((sheet) => `<Relationship Id="${sheet.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheet.target}"/>`).join("\n  ")}
</Relationships>`;
}

/* ── The bounded zip reader ────────────────────────────────────────────── */

describe("the bounded zip reader", () => {
  it("refuses a package whose distinct entries add up past the total inflate budget", async () => {
    // Four 20 MB parts sit under the 24 MB per-entry cap, so only a budget
    // across the whole package can refuse them: without it a deck with many
    // slide parts could allocate without bound.
    const zeros = new Uint8Array(20 * 1024 * 1024);
    const bytes = zipSync({
      "part1.xml": [zeros, { level: 1 }],
      "part2.xml": [zeros, { level: 1 }],
      "part3.xml": [zeros, { level: 1 }],
      "part4.xml": [zeros, { level: 1 }],
    });
    const zip = await openOoxmlZip(bytes);
    expect((await zip.readBytes("part1.xml"))?.length).toBe(zeros.length);
    expect((await zip.readBytes("part2.xml"))?.length).toBe(zeros.length);
    expect((await zip.readBytes("part3.xml"))?.length).toBe(zeros.length);
    await expect(zip.readBytes("part4.xml")).rejects.toMatchObject({ reason: "too-large" });
  }, 30_000);

  it("does not charge the budget twice for a part that is read again", async () => {
    // A preview legitimately re-reads parts (a slide's media on every visit,
    // the shared string table per sheet). Re-reading must not exhaust the
    // budget that only distinct parts are meant to spend.
    const zeros = new Uint8Array(20 * 1024 * 1024);
    const bytes = zipSync({
      "sharedStrings.xml": [zeros, { level: 1 }],
      "sheet1.xml": [zeros, { level: 1 }],
    });
    const zip = await openOoxmlZip(bytes);
    // Ten re-reads of one part stay inside a budget two distinct parts spent.
    for (let round = 0; round < 10; round++) {
      expect((await zip.readBytes("sharedStrings.xml"))?.length).toBe(zeros.length);
    }
    expect((await zip.readBytes("sheet1.xml"))?.length).toBe(zeros.length);
  }, 30_000);
});

/* ── The .xlsx reader ──────────────────────────────────────────────────── */

describe("openXlsx", () => {
  it("lists the sheets in workbook order and opens on the first visible one", async () => {
    const workbook = await openXlsx(xlsxZip({
      "[Content_Types].xml": CONTENT_TYPES,
      "xl/workbook.xml": workbookXml({
        sheets: [
          { name: "Intro", rid: "rId1", state: "hidden" },
          { name: "Numbers", rid: "rId2" },
        ],
      }),
      "xl/_rels/workbook.xml.rels": workbookRels([
        { rid: "rId1", target: "worksheets/sheet1.xml" },
        { rid: "rId2", target: "/xl/worksheets/sheet2.xml" },
      ]),
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden sheet</t></is></c></row></sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>visible</t></is></c></row></sheetData></worksheet>`,
    }));

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Intro", "Numbers"]);
    expect(workbook.sheets[0]!.hidden).toBe(true);
    expect(workbook.defaultSheetIndex).toBe(1);
    const window = await workbook.readSheet(1);
    expect(window.rows[0]![0]).toBe("visible");
  });

  it("resolves shared strings, inline strings, booleans, errors, and formulas", async () => {
    const workbook = await openXlsx(xlsxZip({
      "xl/workbook.xml": workbookXml({ sheets: [{ name: "S", rid: "rId1" }] }),
      "xl/_rels/workbook.xml.rels": workbookRels([{ rid: "rId1", target: "worksheets/sheet1.xml" }]),
      "xl/sharedStrings.xml": `<?xml version="1.0"?><sst count="2">
        <si><t>Alpha &amp; Beta</t></si>
        <si><r><t>rich </t></r><r><t>text</t></r></si>
        <si><t>unused</t></si>
      </sst>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>
        <row r="1">
          <c r="A1" t="s"><v>0</v></c>
          <c r="B1" t="s"><v>1</v></c>
          <c r="C1" t="inlineStr"><is><t>inline</t></is></c>
          <c r="D1" t="b"><v>1</v></c>
          <c r="E1" t="e"><v>#DIV/0!</v></c>
          <c r="F1"><f>SUM(A2:A3)</f></c>
          <c r="G1"><f>1+1</f><v>2</v></c>
        </row>
      </sheetData></worksheet>`,
    }));

    const window = await workbook.readSheet(0);
    expect(window.rows[0]!.slice(0, 7)).toEqual([
      "Alpha & Beta",
      "rich text",
      "inline",
      "TRUE",
      "#DIV/0!",
      "=SUM(A2:A3)",
      "2",
    ]);
  });

  it("reads a prefixed worksheet and a row whose cells carry no reference", async () => {
    // Both are shapes the spec allows and producers do emit: a prefixed
    // SpreadsheetML part, and cells with no `r` (stored in order). Either one
    // read as an empty sheet would look like a broken file.
    const scan = await scanSheetXml(`<?xml version="1.0"?><x:worksheet xmlns:x="urn:spreadsheet">
      <x:dimension ref="A1:B2"/>
      <x:sheetData>
        <x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>prefixed</x:t></x:is></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row>
        <x:row r="2"><x:c t="inlineStr"><x:is><x:t>first</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>second</x:t></x:is></x:c></x:row>
      </x:sheetData>
    </x:worksheet>`);

    expect(scan.rows[0]!.map((cell) => [cell.col, cell.raw])).toEqual([[0, "prefixed"], [1, "2"]]);
    expect(scan.rows[1]!.map((cell) => [cell.col, cell.raw])).toEqual([[0, "first"], [1, "second"]]);
    expect(scan.rowCount).toBe(2);
  });

  it("drops phonetic runs and keeps the real text of a shared string", async () => {
    const workbook = await openXlsx(xlsxZip({
      "xl/workbook.xml": workbookXml({ sheets: [{ name: "S", rid: "rId1" }] }),
      "xl/_rels/workbook.xml.rels": workbookRels([{ rid: "rId1", target: "worksheets/sheet1.xml" }]),
      "xl/sharedStrings.xml": `<?xml version="1.0"?><sst count="1">
        <si><t>kanji</t><rPh sb="0" eb="1"><t>phonetic</t></rPh></si>
      </sst>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    }));
    const window = await workbook.readSheet(0);
    expect(window.rows[0]![0]).toBe("kanji");
  });

  it("formats dates, datetimes, times and percents from styles", async () => {
    const workbook = await openXlsx(xlsxZip({
      "xl/workbook.xml": workbookXml({ sheets: [{ name: "S", rid: "rId1" }] }),
      "xl/_rels/workbook.xml.rels": workbookRels([{ rid: "rId1", target: "worksheets/sheet1.xml" }]),
      "xl/styles.xml": `<?xml version="1.0"?><styleSheet>
        <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts>
        <cellXfs count="6">
          <xf numFmtId="0"/>
          <xf numFmtId="14"/>
          <xf numFmtId="22"/>
          <xf numFmtId="20"/>
          <xf numFmtId="164"/>
          <xf numFmtId="10"/>
        </cellXfs>
      </styleSheet>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>
        <row r="1">
          <c r="A1" s="1"><v>45292</v></c>
          <c r="B1" s="2"><v>45292.5</v></c>
          <c r="C1" s="3"><v>0.25</v></c>
          <c r="D1" s="4"><v>45292</v></c>
          <c r="E1" s="1"><v>59</v></c>
          <c r="F1" s="5"><v>0.125</v></c>
        </row>
      </sheetData></worksheet>`,
    }));

    const window = await workbook.readSheet(0);
    // 45292 is 2024-01-01 in the 1900 system.
    expect(window.rows[0]![0]).toBe("2024-01-01");
    expect(window.rows[0]![1]).toBe("2024-01-01 12:00");
    expect(window.rows[0]![2]).toBe("06:00");
    expect(window.rows[0]![3]).toBe("2024-01-01");
    // Serial 59 is 1900-02-28: the shifted epoch must not move early dates.
    expect(window.rows[0]![4]).toBe("1900-02-28");
    // A builtin percent format renders the value as a percentage.
    expect(window.rows[0]![5]).toBe("12.5%");
  });

  it("keeps the sheet's own row numbers when the used range is sparse", async () => {
    const workbook = await openXlsx(xlsxZip({
      "xl/workbook.xml": workbookXml({ sheets: [{ name: "S", rid: "rId1" }] }),
      "xl/_rels/workbook.xml.rels": workbookRels([{ rid: "rId1", target: "worksheets/sheet1.xml" }]),
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet>
        <dimension ref="A5:B7"/>
        <sheetData>
          <row r="5"><c r="A5" t="inlineStr"><is><t>five</t></is></c></row>
          <row r="7"><c r="B7" t="inlineStr"><is><t>seven</t></is></c></row>
        </sheetData>
      </worksheet>`,
    }));

    const window = await workbook.readSheet(0);
    expect(window.rowNumbers).toEqual([5, 7]);
    expect(window.rows[0]![0]).toBe("five");
    expect(window.rows[1]![1]).toBe("seven");
    expect(window.firstCol).toBe(1);
    expect(window.rowCount).toBe(3); // A5:B7 spans rows 5..7
  });

  it("caps materialized rows and says so instead of growing", async () => {
    const rows = Array.from({ length: SPREADSHEET_PREVIEW_MAX_ROWS + 120 }, (_unused, index) => (
      `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`
    )).join("");
    const scan = await scanSheetXml(`<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`);
    expect(scan.rows.length).toBe(SPREADSHEET_PREVIEW_MAX_ROWS);
    expect(scan.rowCount).toBe(SPREADSHEET_PREVIEW_MAX_ROWS + 120);
    expect(scan.truncatedRows).toBe(true);
  });

  it("does not call a sheet truncated when every row it holds is shown", async () => {
    // Two shapes that must NOT read as truncation: a used range that spans an
    // empty row (Excel writes the dimension, not the row), and a row that only
    // carries formatting (a self-closing `<row/>`).
    const scan = await scanSheetXml(`<?xml version="1.0"?><worksheet>
      <dimension ref="A1:B4"/>
      <sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>one</t></is></c></row>
        <row r="2" ht="30" customHeight="1"/>
        <row r="3"><c r="A3" t="inlineStr"><is><t>three</t></is></c></row>
        <row r="4"><c r="B4" t="inlineStr"><is><t>four</t></is></c></row>
      </sheetData>
    </worksheet>`);
    expect(scan.rowNumbers).toEqual([1, 3, 4]);
    expect(scan.rowCount).toBe(4);
    expect(scan.truncatedRows).toBe(false);
  });

  it("reads column widths from the sheet and clamps absurd ones", async () => {
    const scan = await scanSheetXml(`<?xml version="1.0"?><worksheet>
      <cols><col min="1" max="1" width="22.5" customWidth="1"/><col min="2" max="2" width="900" customWidth="1"/></cols>
      <sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData>
    </worksheet>`);
    expect(scan.colWidthsPx[0]).toBe(163); // round(22.5 * 7) + 5
    expect(scan.colWidthsPx[1]).toBe(320); // clamped
  });

  it("refuses legacy, encrypted, and non-zip files with a typed reason", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(openXlsx(ole)).rejects.toMatchObject({ reason: "encrypted-or-legacy" });
    const notZip = strToU8("date,amount\n2024-01-01,3");
    await expect(openXlsx(notZip)).rejects.toMatchObject({ reason: "not-zip" });
  });

  it("fails with the typed error class for a package with no workbook part", async () => {
    await expect(openXlsx(xlsxZip({ "hello.txt": "hi" }))).rejects.toBeInstanceOf(OoxmlError);
  });
});

describe("formatExcelSerial", () => {
  it("handles both epochs and the 1900 leap bug", () => {
    expect(formatExcelSerial(1, "date", false)).toBe("1900-01-01");
    expect(formatExcelSerial(60, "date", false)).toBe("1900-02-28");
    expect(formatExcelSerial(61, "date", false)).toBe("1900-03-01");
    expect(formatExcelSerial(0, "date", true)).toBe("1904-01-01");
    expect(formatExcelSerial(44927, "date", false)).toBe("2023-01-01");
  });

  it("renders a bare fraction as a time and keeps seconds only when they exist", () => {
    expect(formatExcelSerial(0.5, "time", false)).toBe("12:00");
    expect(formatExcelSerial(0.25, "time", false)).toBe("06:00");
    expect(formatExcelSerial(0.25, "time", true)).toBe("06:00");
    expect(formatExcelSerial(1.5, "time", false)).toBe("12:00");
    expect(formatExcelSerial(45292.500011574074, "datetime", false)).toBe("2024-01-01 12:00:01");
  });
});

describe("classifyFormatCode", () => {
  const cases: Array<[string, ReturnType<typeof classifyFormatCode>]> = [
    ["yyyy-mm-dd", "date"],
    ["mm/dd/yy h:mm", "datetime"],
    ["h:mm:ss", "time"],
    ["[h]:mm:ss", "time"],
    ['"USD" #,##0.00', "general"],
    ["#,##0;[Red]-#,##0", "general"],
    ["0.0%", "percent"],
    ["General", "general"],
    ["m/d/yyyy", "date"],
  ];
  for (const [code, expected] of cases) {
    it(`classifies ${JSON.stringify(code)}`, () => {
      expect(classifyFormatCode(code)).toBe(expected);
    });
  }
});

/* ── The .pptx reader ──────────────────────────────────────────────────── */

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

function bigTableXml(rows: number, columns: number): string {
  const row = (index: number) => `<a:tr>${Array.from({ length: columns }, (_unused, column) => (
    `<a:tc><a:txBody><a:p><a:r><a:t>r${index}c${column}</a:t></a:r></a:p></a:txBody></a:tc>`
  )).join("")}</a:tr>`;
  return Array.from({ length: rows }, (_unused, index) => row(index)).join("");
}

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
    expect(slide.notices.trimmedTables).toBe(0);
    expect(slide.outline).toEqual(["Region Revenue", "APAC $4.2M"]);
  });

  it("trims an oversized table and reports it rather than building every cell", async () => {
    const deck = await openPptx(pptxZip({
      "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }]),
      "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
      "ppt/slides/slide1.xml": `<?xml version="1.0"?>
<p:sld ${P_NS} ${A_NS} ${R_NS}>
  <p:cSld><p:spTree>
    <p:graphicFrame>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl><a:tblPr firstRow="1"/>${bigTableXml(60, 25)}</a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`,
    }));

    const table = deck.slides[0]!.shapes.find((shape) => shape.kind === "table");
    if (table?.kind !== "table") throw new Error("expected a table");
    expect(table.rows.length).toBeLessThan(60);
    expect(table.rows.length).toBeGreaterThan(0);
    expect(table.rows[0]![0]).toBe("r0c0"); // the top of the table is kept
    expect(table.rows[0]!.length).toBeLessThan(25);
    expect(deck.slides[0]!.notices.trimmedTables).toBe(1);
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

/* ── Failure copy ──────────────────────────────────────────────────────── */

describe("ooxmlFailureMessage", () => {
  it("shows a parser's own message and never leaks an unexpected error's text", () => {
    expect(ooxmlFailureMessage(new OoxmlError("not-zip", "This file is not an Office (zip) package.")))
      .toBe("This file is not an Office (zip) package.");
    // An IPC rejection, a DOM exception: the raw text must not reach the card.
    const unexpected = new Error("Chat session 'abc' was not found");
    expect(ooxmlFailureMessage(unexpected)).not.toContain("Chat session");
    expect(ooxmlFailureMessage(unexpected).length).toBeGreaterThan(0);
  });

  it("turns the stream size-limit error into a sentence instead of its byte count", () => {
    const message = ooxmlFailureMessage(new Error("File is too large to stream into memory (26214400 byte limit)."));
    expect(message).not.toContain("26214400");
    expect(message.toLowerCase()).toContain("too large");
  });
});
