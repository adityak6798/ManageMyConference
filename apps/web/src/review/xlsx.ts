/** Minimal browser-side XLSX renderer for review exports. */
import { zipSync } from "fflate";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .split("")
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");

const cellReference = (columnIndex: number, rowNumber: number) => {
  let column = "";
  for (let remaining = columnIndex + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26))
    column = String.fromCharCode(65 + ((remaining - 1) % 26)) + column;
  return `${column}${rowNumber}`;
};

/**
 * Render exactly the rows already visible to the organizer; this function never queries data.
 * Strings stay inline so ids and leading zeroes are preserved, while finite numbers remain
 * numeric for spreadsheet sorting and totals.
 */
export function renderReviewXlsx(rows: readonly (readonly unknown[])[]): Uint8Array {
  const sheetRows = rows
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const rendered = cells
        .map((value, columnIndex) => {
          const ref = cellReference(columnIndex, rowNumber);
          if (typeof value === "number" && Number.isFinite(value))
            return `<c r="${ref}"><v>${value}</v></c>`;
          const raw = String(value ?? "");
          const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(guarded)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowNumber}">${rendered}</row>`;
    })
    .join("");
  const encode = (value: string) => new TextEncoder().encode(value);
  return zipSync(
    {
      "[Content_Types].xml": encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          "</Types>",
      ),
      "_rels/.rels": encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>",
      ),
      "xl/workbook.xml": encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Review results" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          "</Relationships>",
      ),
      "xl/worksheets/sheet1.xml": encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<sheetData>${sheetRows}</sheetData></worksheet>`,
      ),
    },
    { level: 6 },
  );
}
