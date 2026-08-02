#!/usr/bin/env node
'use strict';
/**
 * forge-docs.cjs — zero-dependency real office-document generator (2026-07-19, H1). Node core only
 * (fs/path/zlib/crypto/child_process — the last two only for the optional CLI --run event log and content
 * hashing; no npm package anywhere in this file). PURPOSE: today Forge can talk ABOUT a client deliverable
 * but cannot hand the owner a real .docx/.xlsx/.pptx/.pdf that actually opens in Word/Excel/PowerPoint/a PDF
 * reader — this file closes that gap.
 *
 * WHY THIS IS POSSIBLE WITHOUT A LIBRARY: .docx/.xlsx/.pptx are all OOXML — a plain ZIP container holding a
 * fixed set of required XML parts (Content_Types + package rels + the format's main part(s)). A ZIP file is
 * just: local-file-header + (optionally deflated) bytes, repeated per entry, then a central directory, then
 * an end-of-central-directory record — all of it hand-rollable with Node's own zlib.deflateRawSync and a
 * standard CRC32 table (implemented below, no external crc/zip package). .pdf is not a container at all — a
 * minimal valid PDF is just a handful of numbered objects (catalog/pages/page/font/content-stream) plus an
 * xref table and trailer, built directly as bytes.
 *
 * ZIP WRITER (buildZip): a real, from-scratch, non-Zip64 ZIP writer — local file header (sig 0x04034b50) +
 * filename + compressed bytes per entry, a central directory (sig 0x02014b50) mirroring every entry, and an
 * end-of-central-directory record (sig 0x06054b50). Uses zlib.deflateRawSync (method 8) by default per entry,
 * or raw "store" (method 0) when entry.method === 'store'. CRC32 is a hand-rolled standard IEEE 802.3 table
 * (crc32()), computed over the UNCOMPRESSED bytes (per the ZIP spec — this is the exact thing the mutation
 * test below deliberately corrupts to prove the round-trip actually depends on it). All entries are written
 * with a fixed DOS date/time of 1980-01-01 00:00 (date field 0x0021, time field 0x0000) — deterministic
 * output, and a perfectly valid "no timestamp" per the ZIP spec (year offset 0 from the 1980 epoch).
 *
 * OOXML PARTS EMITTED PER FORMAT (the ones Word/Excel/PowerPoint actually require to open the file):
 *   .docx — [Content_Types].xml, _rels/.rels, word/document.xml (title + heading/paragraph runs; headings
 *           use direct run formatting (w:b/w:sz) rather than a referenced style, so no word/styles.xml part
 *           is needed for the file to be valid).
 *   .xlsx — [Content_Types].xml, _rels/.rels, xl/workbook.xml, xl/_rels/workbook.xml.rels, and one
 *           xl/worksheets/sheetN.xml per input sheet. Cells use inline strings (t="inlineStr"/<is><t>) for
 *           text — a fully valid OOXML alternative to a separate sharedStrings.xml part — and bare <v> for
 *           finite numbers.
 *   .pptx — [Content_Types].xml, _rels/.rels, ppt/presentation.xml (+ its rels), ppt/slideMasters/
 *           slideMaster1.xml (+ rels), ppt/slideLayouts/slideLayout1.xml (+ rels), ppt/theme/theme1.xml
 *           (minimal but schema-complete: 12-color scheme, font scheme, and the required 3-entry
 *           fill/line/effect/bgFill style lists), and one ppt/slides/slideN.xml (+ rels) per input slide.
 *           This is the full required master->layout->slide->theme relationship chain PowerPoint expects —
 *           a bare slide part alone is not sufficient for PowerPoint to open the file.
 *   .pdf  — a single hand-built PDF 1.4 file: Catalog, Pages, one Page object per auto-paginated page, one
 *           shared content-stream object per page, and two standard-14 (no embedding needed) font objects
 *           (Helvetica, Helvetica-Bold), a real xref table with correct byte offsets, and a trailer with
 *           /Root + /Size. Text wrapping uses an approximate average-glyph-width heuristic (documented,
 *           inferred — no font metrics table is embedded), which is sufficient for functional pagination but
 *           not pixel-exact line breaks.
 *
 * MODULE API:
 *   docx({title, sections:[{heading, paragraphs:[...]}]}, opts) -> Buffer (also writes opts.out if given)
 *   xlsx({sheets:[{name, rows:[[...]]}]}, opts) -> Buffer
 *   pptx({slides:[{title, bullets:[...]}]}, opts) -> Buffer
 *   pdf({title, blocks:[{type:'h1'|'p', text}]}, opts) -> Buffer
 *   opts.out (string, optional) — when given, the Buffer is ALSO written to this path (fs.writeFileSync).
 *   opts.run (string, optional) — when given, best-effort logs a `doc_generated` event via
 *     ../forge-dashboard/log-event.cjs (NOT fatal if it fails — see NOTE below).
 *
 *   Internal builders/helpers are exported too (buildZip, crc32, escapeXml, wrapText, buildPdf, colName,
 *   contentTypesXml, relsXml, ...) — this is what forge-docs.test.cjs mutation-verifies directly, and what a
 *   future format extension would reuse rather than re-implement.
 *
 * NOTE on the `doc_generated` event: this is a NEW event_type name declared by this piece, not yet present
 * in log-event.cjs's KNOWN_EVENT_TYPES allow-list (log-event.cjs is a shared file this piece must not edit —
 * a later integration pass registers it). Until then, `--run` best-effort logs it and log-event.cjs's own
 * STRICT mode will warn/refuse with an "unknown event_type" message — this call is intentionally
 * non-fatal (mirrors forge-artifact.cjs's storeArtifact() --run pattern exactly: a non-zero log-event exit
 * only prints a warning to stderr, it never fails doc generation itself).
 *
 * CLI:
 *   node forge-docs.cjs docx --in <input.json> --out <file.docx> [--run <run_id>]
 *   node forge-docs.cjs xlsx --in <input.json> --out <file.xlsx> [--run <run_id>]
 *   node forge-docs.cjs pptx --in <input.json> --out <file.pptx> [--run <run_id>]
 *   node forge-docs.cjs pdf  --in <input.json> --out <file.pdf>  [--run <run_id>]
 * `--in` is a path to a JSON file holding the format's input object (see MODULE API above).
 * Exit codes: 0 = written · 2 = usage error / bad JSON / write failure.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { CLAUDE_DIR } = require('./forge-store.cjs');

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
};
const CT = {
  docxMain: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsxMain: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  pptxMain: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
};

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// ZIP writer — real CRC32 + local/central headers + EOCD, no external package
// ---------------------------------------------------------------------------
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();
/** crc32(buf) -> uint32 IEEE 802.3 CRC-32 of buf (the exact algorithm the ZIP spec requires per entry). */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const DOS_TIME = 0x0000, DOS_DATE = 0x0021; // fixed 1980-01-01 00:00 — deterministic, spec-valid "no timestamp"

/** buildZip(entries) -> Buffer. entries: [{name, data (string|Buffer), method:'deflate'|'store'}].
 *  A real, from-scratch, non-Zip64 ZIP writer — see file header for the format description. This is the
 *  function forge-docs.test.cjs mutation-verifies (corrupting a CRC / central-directory offset here must
 *  make the round-trip "entry present" tests go red). */
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const method = entry.method === 'store' ? 0 : 8;
    const compBuf = method === 8 ? zlib.deflateRawSync(dataBuf) : dataBuf;
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed to extract
    local.writeUInt16LE(0, 6);        // general purpose bit flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);       // extra field length
    localChunks.push(local, nameBuf, compBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);     // version made by
    central.writeUInt16LE(20, 6);     // version needed to extract
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);     // extra field length
    central.writeUInt16LE(0, 32);     // file comment length
    central.writeUInt16LE(0, 34);     // disk number start
    central.writeUInt16LE(0, 36);     // internal file attributes
    central.writeUInt32LE(0, 38);     // external file attributes
    central.writeUInt32LE(offset, 42); // relative offset of local header
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + compBuf.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat(localChunks.concat([centralBuf, eocd]));
}

function contentTypesXml(overrides) {
  return XML_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.join('') + '</Types>';
}
function relsXml(rels) {
  return XML_DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.map((r) => '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + r.target + '"/>').join('') +
    '</Relationships>';
}
function finalizeOutput(buffer, opts) {
  if (opts && opts.out) fs.writeFileSync(opts.out, buffer);
  return buffer;
}

// ---------------------------------------------------------------------------
// .docx
// ---------------------------------------------------------------------------
function docxRun(text, opts) {
  const rPr = opts && opts.big ? '<w:rPr><w:b/><w:sz w:val="' + opts.big + '"/></w:rPr>' : '';
  return '<w:p><w:r>' + rPr + '<w:t xml:space="preserve">' + escapeXml(text) + '</w:t></w:r></w:p>';
}
function buildDocxXml(input) {
  const title = String((input && input.title) || 'Document');
  const sections = Array.isArray(input && input.sections) ? input.sections : [];
  let body = docxRun(title, { big: 56 });
  for (const sec of sections) {
    if (sec && sec.heading) body += docxRun(String(sec.heading), { big: 32 });
    const paragraphs = Array.isArray(sec && sec.paragraphs) ? sec.paragraphs : [];
    for (const p of paragraphs) body += docxRun(String(p));
  }
  body += '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
  return XML_DECL + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>';
}
/** docx(input, opts) -> Buffer — see file header MODULE API. */
function docx(input, opts) {
  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(['<Override PartName="/word/document.xml" ContentType="' + CT.docxMain + '"/>']) },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' }]) },
    { name: 'word/document.xml', data: buildDocxXml(input) },
  ];
  return finalizeOutput(buildZip(entries), opts);
}

// ---------------------------------------------------------------------------
// .xlsx
// ---------------------------------------------------------------------------
/** colName(idx) -> zero-based column index to an Excel column letter (0->A, 25->Z, 26->AA, ...). */
function colName(idx) {
  let n = idx, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function xlsxCellXml(value, ref) {
  if (typeof value === 'number' && Number.isFinite(value)) return '<c r="' + ref + '"><v>' + value + '</v></c>';
  const text = escapeXml(value == null ? '' : String(value));
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + text + '</t></is></c>';
}
function buildXlsxParts(input) {
  const sheets = (Array.isArray(input && input.sheets) && input.sheets.length) ? input.sheets : [{ name: 'Sheet1', rows: [] }];
  const sheetParts = [];
  const sheetEntries = [];
  const relEntries = [];
  const overrides = [];
  sheets.forEach((sheet, idx) => {
    const num = idx + 1;
    const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
    let rowsXml = '';
    rows.forEach((row, rIdx) => {
      const cells = Array.isArray(row) ? row : [];
      let cellsXml = '';
      cells.forEach((cell, cIdx) => { cellsXml += xlsxCellXml(cell, colName(cIdx) + (rIdx + 1)); });
      rowsXml += '<row r="' + (rIdx + 1) + '">' + cellsXml + '</row>';
    });
    sheetParts.push({ name: 'xl/worksheets/sheet' + num + '.xml', data: XML_DECL + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rowsXml + '</sheetData></worksheet>' });
    sheetEntries.push('<sheet name="' + escapeXml(String((sheet && sheet.name) || ('Sheet' + num))) + '" sheetId="' + num + '" r:id="rId' + num + '"/>');
    relEntries.push({ id: 'rId' + num, type: REL.worksheet, target: 'worksheets/sheet' + num + '.xml' });
    overrides.push('<Override PartName="/xl/worksheets/sheet' + num + '.xml" ContentType="' + CT.worksheet + '"/>');
  });
  const workbookXml = XML_DECL + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheetEntries.join('') + '</sheets></workbook>';
  return { sheetParts, workbookXml, workbookRels: relsXml(relEntries), overrides };
}
/** xlsx(input, opts) -> Buffer — see file header MODULE API. */
function xlsx(input, opts) {
  const built = buildXlsxParts(input);
  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(['<Override PartName="/xl/workbook.xml" ContentType="' + CT.xlsxMain + '"/>'].concat(built.overrides)) },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'xl/workbook.xml' }]) },
    { name: 'xl/workbook.xml', data: built.workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: built.workbookRels },
  ].concat(built.sheetParts);
  return finalizeOutput(buildZip(entries), opts);
}

// ---------------------------------------------------------------------------
// .pptx
// ---------------------------------------------------------------------------
const THEME1_XML = XML_DECL + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Forge Theme"><a:themeElements>' +
  '<a:clrScheme name="Forge"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Forge"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Forge">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>';

const SLIDE_MASTER1_XML = XML_DECL + '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
const SLIDE_MASTER1_RELS = relsXml([
  { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
  { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
]);

const SLIDE_LAYOUT1_XML = XML_DECL + '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>' +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
const SLIDE_LAYOUT1_RELS = relsXml([{ id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }]);

function pptxSlideXml(slide) {
  const title = escapeXml(String((slide && slide.title) || ''));
  const bullets = Array.isArray(slide && slide.bullets) ? slide.bullets : [];
  const bulletParas = bullets.map((b) => '<a:p><a:r><a:t>' + escapeXml(String(b)) + '</a:t></a:r></a:p>').join('') || '<a:p/>';
  return XML_DECL + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>' + title + '</a:t></a:r></a:p></p:txBody></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + bulletParas + '</p:txBody></p:sp>' +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}
/** pptx(input, opts) -> Buffer — see file header MODULE API. Full required master->layout->slide->theme
 *  relationship chain (see file header "OOXML PARTS EMITTED PER FORMAT"). */
function pptx(input, opts) {
  const slides = (Array.isArray(input && input.slides) && input.slides.length) ? input.slides : [{ title: '', bullets: [] }];
  const slideParts = [];
  const slideRelParts = [];
  const presRelEntries = [{ id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' }];
  const sldIdEntries = [];
  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="' + CT.pptxMain + '"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="' + CT.slideMaster + '"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="' + CT.slideLayout + '"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="' + CT.theme + '"/>',
  ];
  slides.forEach((slide, idx) => {
    const num = idx + 1;
    const rId = 'rId' + (num + 1);
    slideParts.push({ name: 'ppt/slides/slide' + num + '.xml', data: pptxSlideXml(slide) });
    slideRelParts.push({ name: 'ppt/slides/_rels/slide' + num + '.xml.rels', data: relsXml([{ id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }]) });
    presRelEntries.push({ id: rId, type: REL.slide, target: 'slides/slide' + num + '.xml' });
    sldIdEntries.push('<p:sldId id="' + (255 + num) + '" r:id="' + rId + '"/>');
    overrides.push('<Override PartName="/ppt/slides/slide' + num + '.xml" ContentType="' + CT.slide + '"/>');
  });
  const presentationXml = XML_DECL + '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + sldIdEntries.join('') + '</p:sldIdLst>' +
    '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';

  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(overrides) },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' }]) },
    { name: 'ppt/presentation.xml', data: presentationXml },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRelEntries) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER1_XML },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: SLIDE_MASTER1_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT1_XML },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: SLIDE_LAYOUT1_RELS },
    { name: 'ppt/theme/theme1.xml', data: THEME1_XML },
  ].concat(slideParts, slideRelParts);
  return finalizeOutput(buildZip(entries), opts);
}

// ---------------------------------------------------------------------------
// .pdf — hand-built PDF 1.4 (no OOXML/ZIP involved)
// ---------------------------------------------------------------------------
const PDF_PAGE_W = 612, PDF_PAGE_H = 792, PDF_MARGIN = 72;

/** wrapText(text, size, maxWidth) -> string[]. Word-wraps using an approximate average-glyph-width
 *  heuristic (documented limitation — see file header: no embedded font metrics table, so this is
 *  functional pagination, not pixel-exact line breaks). */
function wrapText(text, size, maxWidth) {
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const avgCharWidth = size * 0.5;
  const lines = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w;
    if (cur && candidate.length * avgCharWidth > maxWidth) { lines.push(cur); cur = w; }
    else cur = candidate;
  }
  if (cur) lines.push(cur);
  return lines;
}
/** escapePdfText(s) -> a PDF literal-string-safe value (backslash and parens escaped per the PDF spec). */
function escapePdfText(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function pdfLayout(input) {
  const title = String((input && input.title) || 'Document');
  const blocks = [{ type: 'h1', text: title }].concat(Array.isArray(input && input.blocks) ? input.blocks : []);
  const maxWidth = PDF_PAGE_W - PDF_MARGIN * 2;
  const raw = [];
  for (const b of blocks) {
    const isH1 = b && b.type === 'h1';
    const size = isH1 ? 18 : 11;
    const font = isH1 ? 'F2' : 'F1';
    for (const line of wrapText((b && b.text) || '', size, maxWidth)) raw.push({ text: line, size, font, gapAfter: isH1 ? 6 : 3 });
  }
  const pages = [];
  let current = [];
  let y = PDF_PAGE_H - PDF_MARGIN;
  for (const ln of raw) {
    const lh = ln.size * 1.4;
    if (y - lh < PDF_MARGIN) { pages.push(current); current = []; y = PDF_PAGE_H - PDF_MARGIN; }
    current.push(Object.assign({}, ln, { y }));
    y -= lh + ln.gapAfter;
  }
  pages.push(current);
  return pages;
}
function pdfPageContentStream(lines) {
  const ops = lines.map((l) => '/' + l.font + ' ' + l.size + ' Tf\n1 0 0 1 ' + PDF_MARGIN + ' ' + l.y.toFixed(2) + ' Tm\n(' + escapePdfText(l.text) + ') Tj').join('\n');
  return 'BT\n' + ops + '\nET';
}
/** buildPdf(input) -> Buffer. A real, hand-built, valid PDF 1.4 — see file header "OOXML PARTS EMITTED
 *  PER FORMAT" (.pdf entry) for the object model and the xref/trailer contract. */
function buildPdf(input) {
  const pages = pdfLayout(input);
  const numPages = pages.length;
  // object numbers: 1=Catalog 2=Pages 3=Font(F1 Helvetica) 4=Font(F2 Helvetica-Bold)
  // then per page i (0-based): page obj = 5 + i*2, content obj = 6 + i*2
  const pageObjNum = (i) => 5 + i * 2;
  const contentObjNum = (i) => 6 + i * 2;
  const totalObjs = 4 + numPages * 2;

  const objs = new Array(totalObjs + 1); // 1-indexed
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = [];
  for (let i = 0; i < numPages; i++) kids.push(pageObjNum(i) + ' 0 R');
  objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + numPages + ' >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  for (let i = 0; i < numPages; i++) {
    objs[pageObjNum(i)] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PDF_PAGE_W + ' ' + PDF_PAGE_H + '] ' +
      '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + contentObjNum(i) + ' 0 R >>';
    const stream = pdfPageContentStream(pages[i]);
    const streamBuf = Buffer.from(stream, 'latin1');
    objs[contentObjNum(i)] = { stream: streamBuf };
  }

  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const chunks = [header];
  const xrefOffsets = new Array(totalObjs + 1).fill(0);
  let offset = header.length;
  for (let n = 1; n <= totalObjs; n++) {
    xrefOffsets[n] = offset;
    const body = objs[n];
    let objBuf;
    if (body && typeof body === 'object' && body.stream) {
      const pre = Buffer.from(n + ' 0 obj\n<< /Length ' + body.stream.length + ' >>\nstream\n', 'latin1');
      const post = Buffer.from('\nendstream\nendobj\n', 'latin1');
      objBuf = Buffer.concat([pre, body.stream, post]);
    } else {
      objBuf = Buffer.from(n + ' 0 obj\n' + body + '\nendobj\n', 'latin1');
    }
    chunks.push(objBuf);
    offset += objBuf.length;
  }
  const xrefStart = offset;
  const xrefLines = ['xref', '0 ' + (totalObjs + 1), '0000000000 65535 f '];
  for (let n = 1; n <= totalObjs; n++) xrefLines.push(String(xrefOffsets[n]).padStart(10, '0') + ' 00000 n ');
  const xrefBuf = Buffer.from(xrefLines.join('\n') + '\n', 'latin1');
  chunks.push(xrefBuf);

  const trailer = '<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>';
  const tail = Buffer.from('trailer\n' + trailer + '\nstartxref\n' + xrefStart + '\n%%EOF', 'latin1');
  chunks.push(tail);

  return Buffer.concat(chunks);
}
/** pdf(input, opts) -> Buffer — see file header MODULE API. */
function pdf(input, opts) { return finalizeOutput(buildPdf(input), opts); }

module.exports = {
  docx, xlsx, pptx, pdf,
  buildZip, crc32, escapeXml, colName, wrapText, escapePdfText, buildPdf, buildDocxXml, buildXlsxParts,
  contentTypesXml, relsXml, finalizeOutput, XML_DECL, REL, CT,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function logDocEvent(runId, extra) {
  const logEventPath = path.join(CLAUDE_DIR, 'forge-dashboard', 'log-event.cjs');
  return spawnSync(process.execPath, [logEventPath, runId, 'doc_generated', JSON.stringify(extra || {})], { encoding: 'utf8' });
}
function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { cmd: null, in: null, out: null, run: null, help: true };
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, in: null, out: null, run: null, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--in') opts.in = rest[++i];
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--run') opts.run = rest[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-docs.cjs <docx|xlsx|pptx|pdf> --in <input.json> --out <file> [--run <run_id>]');
}
const GENERATORS = { docx, xlsx, pptx, pdf };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); process.exitCode = 0; }
  else if (!opts.cmd || !GENERATORS[opts.cmd]) { console.error('forge-docs: unknown or missing format command'); printUsage(); process.exitCode = 2; }
  else if (!opts.in || !opts.out) { console.error('forge-docs: --in and --out are both required'); printUsage(); process.exitCode = 2; }
  else {
    try {
      const raw = fs.readFileSync(opts.in, 'utf8');
      let input;
      try { input = JSON.parse(raw); } catch (e) { throw new Error('invalid JSON in ' + opts.in + ': ' + e.message); }
      const buf = GENERATORS[opts.cmd](input, { out: opts.out });
      console.log('forge-docs: wrote ' + opts.out + ' (' + buf.length + ' bytes, ' + opts.cmd + ')');
      if (opts.run) {
        const g = logDocEvent(opts.run, { format: opts.cmd, out: opts.out, bytes: buf.length });
        if (g.status !== 0) console.error('forge-docs: log-event (doc_generated) warning: ' + (g.stderr || '').trim());
      }
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-docs: ' + e.message);
      process.exitCode = 2;
    }
  }
}
