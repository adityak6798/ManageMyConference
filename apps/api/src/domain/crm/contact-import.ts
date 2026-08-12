/**
 * Reading a contact spreadsheet.
 *
 * Pure, and deliberately separate from the service: the same function produces the preview an
 * organizer approves and the rows the import then writes, so what was shown and what was
 * committed cannot drift. Deciding whether a row creates or updates needs the existing
 * directory, so that judgement belongs to the application; everything decidable from the file
 * alone is decided here.
 *
 * @spec PRD-CRM-001
 */
import { normalizeEmail } from "./contact";

export interface ParsedContactRow {
  /** 1-based line number in the file, header included, so an error names the line a person sees. */
  readonly line: number;
  readonly name: string;
  readonly email: string;
  readonly company: string | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly fields: readonly { key: string; value: string }[];
  /** Empty when the row is importable. */
  readonly errors: readonly string[];
}

export interface ParsedContactCsv {
  readonly rows: readonly ParsedContactRow[];
  /** A file-level refusal — a missing header column. Individual bad rows are reported per row. */
  readonly errors: readonly string[];
}

const REQUIRED_COLUMNS = ["name", "email"] as const;
const KNOWN_COLUMNS = new Set(["name", "email", "company", "title", "notes", "tags"]);
/** Deliberately loose: the directory stores addresses it was given, it does not deliver to them. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Split one CSV line, honouring `"` quoting and doubled `""` escapes.
 *
 * Hand-written because the alternative is a dependency in a layer that declares none, and the
 * grammar a spreadsheet export produces is this small.
 */
function splitLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character !== '"') value += character;
      else if (line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      values.push(value);
      value = "";
    } else value += character;
  }
  values.push(value);
  return values.map((entry) => entry.trim());
}

/**
 * A quoted field may contain newlines, so the file cannot simply be split on them.
 * `\r\n` and `\r` are normalised first because the files that need importing come from Excel.
 */
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let record = "";
  let quoted = false;
  for (const character of text.replace(/\r\n?/g, "\n")) {
    if (character === '"') quoted = !quoted;
    if (character === "\n" && !quoted) {
      records.push(record);
      record = "";
      continue;
    }
    record += character;
  }
  records.push(record);
  return records;
}

export function parseContactCsv(text: string): ParsedContactCsv {
  const records = splitRecords(text).map((record, index) => ({ record, line: index + 1 }));
  const headerRecord = records.find(({ record }) => record.trim().length > 0);
  if (!headerRecord) return { rows: [], errors: ["The file is empty."] };
  const header = splitLine(headerRecord.record).map((column) => column.toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0)
    return { rows: [], errors: [`The header row is missing: ${missing.join(", ")}.`] };
  const unknown = header.filter(
    (column) => column.length > 0 && !KNOWN_COLUMNS.has(column) && !column.startsWith("field:"),
  );

  const rows: ParsedContactRow[] = [];
  for (const { record, line } of records) {
    if (line <= headerRecord.line || record.trim().length === 0) continue;
    const values = splitLine(record);
    const cell = (column: string) => {
      const index = header.indexOf(column);
      return index === -1 ? "" : (values[index] ?? "");
    };
    const errors: string[] = [];
    if (values.length !== header.length)
      errors.push(`Expected ${header.length} columns but found ${values.length}.`);
    const name = cell("name");
    const email = normalizeEmail(cell("email"));
    if (!name) errors.push("A name is required.");
    if (name.length > 160) errors.push("The name is longer than 160 characters.");
    if (!EMAIL.test(email)) errors.push(`"${cell("email")}" is not an email address.`);
    const optional = (column: string) => cell(column) || null;
    rows.push({
      line,
      name,
      email,
      company: optional("company"),
      title: optional("title"),
      notes: optional("notes"),
      // Semicolons, because a comma inside a tag list is what quoting exists for and every
      // spreadsheet gets it subtly wrong.
      tags: [
        ...new Set(
          cell("tags")
            .split(";")
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
      fields: header
        .map((column, index) => ({ column, value: (values[index] ?? "").trim() }))
        .filter(({ column, value }) => column.startsWith("field:") && value.length > 0)
        .map(({ column, value }) => ({ key: column.slice("field:".length), value })),
      errors,
    });
  }
  return {
    rows,
    // Not a refusal: an unrecognised column is ignored, and saying so is more useful than
    // failing a 400-row file because somebody exported one extra column.
    errors: unknown.length > 0 ? [`Ignored unrecognised columns: ${unknown.join(", ")}.`] : [],
  };
}
