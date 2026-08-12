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
  /**
   * 1-based *record* number, header included — which is the physical line number for every
   * ordinary file, and drifts from it only where an earlier quoted field contained a newline.
   * A row number is what an error should name, and a record is what a row is.
   */
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

/**
 * The most rows one import may carry.
 *
 * Every row costs at least one read to classify and one statement to commit, so the megabyte
 * the transport permits is not a useful bound on the work: a file that is almost entirely rows
 * exhausts a Worker's query budget partway through and leaves a partial import. Refusing up
 * front is the honest failure, and the number is here rather than in the contract because the
 * limit is about what this domain can do, not about what a request may weigh.
 */
export const MAX_IMPORT_ROWS = 500;

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
    if (!EMAIL.test(email)) errors.push(`"${cell("email")}" is not an email address.`);
    const optional = (column: string) => cell(column) || null;
    const tags = [
      ...new Set(
        // Semicolons, because a comma inside a tag list is what quoting exists for and every
        // spreadsheet gets it subtly wrong.
        cell("tags")
          .split(";")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    /*
     * Deduped by key, last column winning, because storage collapses them the same way:
     * `crm_contact_fields` is keyed on `(contact_id, field_key)` and the write upserts. Left
     * undeduped, a sheet with two `field:topic` columns produced a response describing two
     * fields where one was stored, and made the capacity count one higher than the contact
     * would actually carry — a refusal for something committing would not have done.
     */
    const fields = [
      ...new Map(
        header
          .map((column, index) => ({ column, value: (values[index] ?? "").trim() }))
          .filter(({ column, value }) => column.startsWith("field:") && value.length > 0)
          // Trimmed, because `field: topic` is what a spreadsheet produces when somebody types
          // a space after the colon, and an untrimmed key is a different key from the same
          // column.
          .map(({ column, value }) => [column.slice("field:".length).trim(), value] as const),
      ),
    ].map(([key, value]) => ({ key, value }));
    /*
     * Every bound the hand-typed create path enforces through `createContactInputSchema`, both
     * ends of each one.
     *
     * They are checked here rather than only there because a spreadsheet is the one way a value
     * reaches storage without passing that schema, and the *read* contract reuses the same
     * limits — so a row this misses does not merely store something odd, it makes every later
     * directory response fail the client's decode, with no way back through the UI. That is
     * also why the minimums matter and not only the maximums: a header column of exactly
     * `field:` yields an empty key, which `contactCustomFieldSchema`'s `min(1)` rejects just as
     * firmly as an over-long one. A row that breaks a bound is refused by name and the rest of
     * the file still imports.
     */
    for (const [label, value, limit] of [
      ["name", name, 160],
      ["company", cell("company"), 160],
      ["title", cell("title"), 160],
      ["notes", cell("notes"), 4000],
    ] as const)
      if (value.length > limit) errors.push(`The ${label} is longer than ${limit} characters.`);
    if (tags.length > 20)
      errors.push(`A contact may carry 20 tags, and this row has ${tags.length}.`);
    for (const tag of tags)
      if (tag.length > 40) errors.push(`The tag "${tag}" is longer than 40 characters.`);
    if (fields.length > 30)
      errors.push(`A contact may carry 30 custom fields, and this row has ${fields.length}.`);
    for (const field of fields) {
      if (field.key.length === 0) errors.push('A "field:" column needs a name after the colon.');
      if (field.key.length > 60)
        errors.push(`The column "field:${field.key}" names a field longer than 60 characters.`);
      if (field.value.length > 300)
        errors.push(`The value for "${field.key}" is longer than 300 characters.`);
    }
    rows.push({
      line,
      name,
      email,
      company: optional("company"),
      title: optional("title"),
      notes: optional("notes"),
      tags,
      fields,
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
