/**
 * Rendering a report result as CSV or XLSX.
 *
 * **These take a `ReportResult`, not a query.** That is the whole of how the export cannot bypass
 * the per-field decision: the rows arriving here have already been filtered by the caller's own
 * grants, redacted by their custom role, and masked by the PII rule. There is no path from a
 * download to a row the screen would not show, because a download is a *format* applied to what
 * the screen was given.
 *
 * The XLSX is written by hand rather than with a spreadsheet library, and the reason is the
 * dependency rather than the fun: `fflate` is already in this Worker for the deliverables ZIP, an
 * XLSX *is* a ZIP of five small XML parts, and adding a spreadsheet library to a Worker bundle to
 * write four hundred cells is a poor trade. Everything below is the minimum a conformant reader
 * requires, and every string is inline (`t="inlineStr"`) so there is no shared-strings table to
 * keep in step with the sheet.
 *
 * @spec PRD-OPS-001 PRD-IAM-002
 */
import { zipSync } from "fflate";
import type { ReportResult } from "../../application/platform/report-catalogue";

/**
 * One CSV cell.
 *
 * The leading apostrophe on `=`, `+`, `-` and `@` is formula-injection defence, and it is not
 * optional for an export a spreadsheet opens: a cell beginning `=HYPERLINK(...)` is executed by
 * Excel and by Sheets, so a speaker's "organization" field is an attack surface the moment this
 * file is opened by somebody else.
 */
function csvCell(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function renderReportCsv(result: ReportResult): string {
  const header = result.fields.map((field) => csvCell(field.label)).join(",");
  const rows = result.rows.map((row) =>
    result.fields.map((field) => csvCell(row[field.key] ?? null)).join(","),
  );
  // CRLF, because that is what RFC 4180 says and what Excel expects from a `.csv` it did not write.
  return [header, ...rows].join("\r\n");
}

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // Control characters are not representable in XML 1.0 at all, and a stray one makes the whole
    // workbook unreadable rather than one cell wrong.
    .split("")
    .filter(isXmlSafe)
    .join("");

/**
 * Everything XML 1.0 can carry: C0 only for tab, newline and carriage return, and never DEL.
 *
 * Tested by code point rather than by a character class, because a regular expression naming a
 * control character is itself a lint refusal — and because the range reads as the rule the XML
 * specification states rather than as a run of escapes.
 */
function isXmlSafe(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  return code >= 0x20 && code !== 0x7f;
}

/** `A1`, `B1`, … `AA1`. Written out because a 27th column is where a naive version breaks. */
function cellReference(columnIndex: number, rowNumber: number): string {
  let column = "";
  let remaining = columnIndex + 1;
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    column = String.fromCharCode(65 + modulo) + column;
    remaining = Math.floor((remaining - modulo) / 26);
  }
  return `${column}${rowNumber}`;
}

export function renderReportXlsx(result: ReportResult, sheetName = "Report"): Uint8Array {
  const rows = [
    result.fields.map((field) => field.label),
    ...result.rows.map((row) =>
      result.fields.map((field) => {
        const value = row[field.key] ?? null;
        return value === null ? "" : value;
      }),
    ),
  ];
  const sheetRows = rows
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const xml = cells
        .map((value, columnIndex) => {
          const reference = cellReference(columnIndex, rowNumber);
          // A number stays a number so a spreadsheet can total a column; everything else is an
          // inline string, which is also what keeps a leading zero from being eaten.
          if (typeof value === "number" && Number.isFinite(value))
            return `<c r="${reference}"><v>${value}</v></c>`;
          return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(
            String(value),
          )}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowNumber}">${xml}</row>`;
    })
    .join("");

  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
    "xl/workbook.xml": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        // A sheet name may not exceed 31 characters or contain []:*?/\ — a reader rejects the
        // whole workbook rather than the name, so this is trimmed rather than trusted.
        `<sheets><sheet name="${escapeXml(sheetName.replaceAll(/[[\]:*?/\\]/g, " ").slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>` +
        "</workbook>",
    ),
    "xl/_rels/workbook.xml.rels": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        "</Relationships>",
    ),
    "xl/worksheets/sheet1.xml": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${sheetRows}</sheetData>` +
        "</worksheet>",
    ),
  };
  return zipSync(files, { level: 6 });
}
