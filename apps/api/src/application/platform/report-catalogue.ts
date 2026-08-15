/**
 * The allowlisted schema a report may be written against, and the engine that answers one.
 *
 * Issue #196's reporting area rests on two decisions that are easier to see together.
 *
 * **There is no query language and no stored result.** A report definition names a dataset from
 * this catalogue and a set of field, filter, group and sort choices, each validated against the
 * catalogue on the way in *and* on the way out. Nothing a caller writes reaches storage as a
 * fragment, so there is nothing to escape and nothing to inject into — and a natural-language
 * draft is exactly as safe as a hand-built one, because both must land as a `ReportQuery` this
 * module can validate before anything runs. That is the whole of "must never execute an
 * unvalidated provider expression".
 *
 * **Rows come from the owning domains' declared read interfaces.** `PlatformSources` is the same
 * seam search and the inbox already read through, so a report answers exactly what its caller's
 * role can already open — including the per-field redaction a custom role imposes, because the
 * content workspace and the CRM directory redact before platform ever sees a row. A reporting
 * boundary that queried tables directly would be a second authorization model beside the one
 * every other surface obeys.
 *
 * The cost, stated: this filters and groups in memory over reads the console makes anyway, so a
 * dataset large enough to need a real query planner needs a different design. `GAP-022` already
 * records that point for search, and reporting sits behind the same limit.
 *
 * @spec PRD-OPS-001 PRD-IAM-002 ARC-DOM-001
 */

export type ReportDatasetKey =
  | "sessions"
  | "speakers"
  | "submissions"
  | "reviews"
  | "deliverables"
  | "contacts"
  | "agenda"
  | "communications";

export const REPORT_DATASETS: readonly ReportDatasetKey[] = [
  "sessions",
  "speakers",
  "submissions",
  "reviews",
  "deliverables",
  "contacts",
  "agenda",
  "communications",
];

export type ReportFieldType = "text" | "number" | "date";

export interface ReportField {
  readonly key: string;
  readonly label: string;
  readonly type: ReportFieldType;
  /**
   * Personal data, masked unless the caller holds `reports:pii` and asks for it explicitly.
   *
   * Marked on the *field* rather than decided per surface, so the screen, the CSV, the XLSX, the
   * JSON and a share link cannot disagree about what counts as personal. A field a custom role
   * hides never arrives here at all — that decision happened in the owning domain.
   */
  readonly pii?: boolean;
}

export interface ReportDataset {
  readonly key: ReportDatasetKey;
  readonly label: string;
  /** Which platform source answers it, for the degradation message when one is unwired. */
  readonly source: string;
  readonly fields: readonly ReportField[];
}

/**
 * Every dataset a report may be asked of.
 *
 * Adding a field here is the one edit that widens what a report can select, and it sits next to
 * the mapper that produces it (`report-rows.ts`), so the two cannot drift into a catalogue
 * advertising a column nothing fills.
 */
export const REPORT_CATALOGUE: readonly ReportDataset[] = [
  {
    key: "sessions",
    label: "Sessions",
    source: "content",
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "format", label: "Format", type: "text" },
      { key: "track", label: "Track", type: "text" },
      { key: "publicationState", label: "Publication state", type: "text" },
      { key: "speakerCount", label: "Speakers", type: "number" },
      { key: "abstractLength", label: "Abstract length", type: "number" },
    ],
  },
  {
    key: "speakers",
    label: "Speakers",
    source: "content",
    fields: [
      { key: "name", label: "Name", type: "text" },
      { key: "email", label: "Email", type: "text", pii: true },
      { key: "organization", label: "Organization", type: "text" },
      { key: "workflowStatus", label: "Onboarding status", type: "text" },
      { key: "openTasks", label: "Open tasks", type: "number" },
    ],
  },
  {
    key: "submissions",
    label: "Submissions and decisions",
    source: "review",
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "submitterName", label: "Submitter", type: "text", pii: true },
      { key: "status", label: "Status", type: "text" },
      { key: "assignmentCount", label: "Reviewers assigned", type: "number" },
    ],
  },
  {
    key: "reviews",
    label: "Review progress",
    source: "review",
    fields: [
      { key: "proposalTitle", label: "Proposal", type: "text" },
      { key: "reviewerId", label: "Reviewer", type: "text", pii: true },
      { key: "state", label: "Evaluation state", type: "text" },
      { key: "assignedAt", label: "Assigned", type: "date" },
    ],
  },
  {
    key: "deliverables",
    label: "Speaker deliverables",
    source: "content",
    fields: [
      { key: "title", label: "Task", type: "text" },
      { key: "speakerName", label: "Speaker", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "dueAt", label: "Due", type: "date" },
    ],
  },
  {
    key: "contacts",
    label: "CRM contacts",
    source: "crm",
    fields: [
      { key: "name", label: "Name", type: "text" },
      { key: "company", label: "Company", type: "text" },
      { key: "stage", label: "Pipeline stage", type: "text" },
      { key: "email", label: "Email", type: "text", pii: true },
    ],
  },
  {
    key: "agenda",
    label: "Agenda and publication",
    source: "agenda",
    fields: [
      { key: "sessionTitle", label: "Session", type: "text" },
      { key: "room", label: "Room", type: "text" },
      { key: "startsAt", label: "Starts", type: "date" },
      { key: "placed", label: "Placed", type: "text" },
    ],
  },
  {
    key: "communications",
    label: "Communications",
    source: "communications",
    fields: [
      { key: "subject", label: "Subject", type: "text" },
      { key: "recipient", label: "Recipient", type: "text", pii: true },
      { key: "trigger", label: "Trigger", type: "text" },
      { key: "state", label: "State", type: "text" },
      { key: "attempts", label: "Attempts", type: "number" },
    ],
  },
];

export function datasetOf(key: string): ReportDataset | undefined {
  return REPORT_CATALOGUE.find((dataset) => dataset.key === key);
}

export type ReportOperator =
  | "equals"
  | "not-equals"
  | "contains"
  | "starts-with"
  | "greater-than"
  | "less-than"
  | "is-empty"
  | "is-not-empty";

export const REPORT_OPERATORS: readonly ReportOperator[] = [
  "equals",
  "not-equals",
  "contains",
  "starts-with",
  "greater-than",
  "less-than",
  "is-empty",
  "is-not-empty",
];

export interface ReportFilter {
  readonly field: string;
  readonly operator: ReportOperator;
  /** Absent for the two operators that take no operand. */
  readonly value?: string | undefined;
}

export interface ReportQuery {
  readonly dataset: ReportDatasetKey;
  /** Empty selects every field of the dataset, in catalogue order. */
  readonly fields: readonly string[];
  readonly filters: readonly ReportFilter[];
  readonly groupBy?: string | undefined;
  readonly sort?: { readonly field: string; readonly direction: "asc" | "desc" } | undefined;
  readonly limit: number;
  readonly offset: number;
}

export const MAX_REPORT_PAGE = 500;
export const DEFAULT_REPORT_PAGE = 50;
export const MAX_REPORT_FILTERS = 12;
/**
 * The most rows a report will scan before it refuses.
 *
 * A cost bound rather than a page size: the page is what a caller receives, and this is what the
 * engine is willing to look at to produce it. Issue #196 asks for query-cost bounds with
 * actionable errors, and an actionable error here is "narrow the filters", which is exactly what
 * the refusal says.
 */
export const MAX_REPORT_SCAN = 20_000;

export class ReportQueryInvalidError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

export class ReportTooExpensiveError extends Error {
  constructor(readonly scanned: number) {
    super(
      `This report would scan ${scanned} rows, and the limit is ${MAX_REPORT_SCAN}. Add a filter to narrow it.`,
    );
  }
}

/**
 * Validate a caller's query against the catalogue, or refuse it.
 *
 * Everything a caller can influence passes through here — including a natural-language draft,
 * which is why NL generation is safe: it produces a candidate `ReportQuery` and this decides
 * whether it is one. A field, an operator or a grouping the catalogue does not have is a refusal
 * naming what was wrong, never a silently dropped clause.
 */
export function validateQuery(input: {
  dataset: string;
  fields?: readonly string[] | undefined;
  filters?: readonly { field: string; operator: string; value?: string | undefined }[] | undefined;
  groupBy?: string | undefined;
  sort?: { field: string; direction: string } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): ReportQuery {
  const dataset = datasetOf(input.dataset);
  if (!dataset)
    throw new ReportQueryInvalidError("That dataset is not one a report can be written against.", {
      dataset: ["Choose one of the offered datasets."],
    });
  const known = new Set(dataset.fields.map((field) => field.key));
  const errors: Record<string, string[]> = {};

  const fields = (input.fields ?? []).filter((field, index, all) => all.indexOf(field) === index);
  for (const field of fields)
    if (!known.has(field))
      errors[`fields.${field}`] = [`${dataset.label} has no field called ${field}.`];

  const filters: ReportFilter[] = [];
  const supplied = input.filters ?? [];
  if (supplied.length > MAX_REPORT_FILTERS)
    errors.filters = [`A report carries at most ${MAX_REPORT_FILTERS} filters.`];
  for (const [index, filter] of supplied.slice(0, MAX_REPORT_FILTERS).entries()) {
    if (!known.has(filter.field)) {
      errors[`filters.${index}.field`] = [`${dataset.label} has no field called ${filter.field}.`];
      continue;
    }
    if (!REPORT_OPERATORS.includes(filter.operator as ReportOperator)) {
      errors[`filters.${index}.operator`] = [`${filter.operator} is not a comparison.`];
      continue;
    }
    const operator = filter.operator as ReportOperator;
    const takesValue = operator !== "is-empty" && operator !== "is-not-empty";
    if (takesValue && !(filter.value ?? "").trim()) {
      errors[`filters.${index}.value`] = ["This comparison needs a value."];
      continue;
    }
    filters.push({
      field: filter.field,
      operator,
      ...(takesValue ? { value: (filter.value ?? "").slice(0, 200) } : {}),
    });
  }

  if (input.groupBy && !known.has(input.groupBy))
    errors.groupBy = [`${dataset.label} has no field called ${input.groupBy}.`];
  if (input.sort && !known.has(input.sort.field))
    errors["sort.field"] = [`${dataset.label} has no field called ${input.sort.field}.`];
  if (input.sort && !["asc", "desc"].includes(input.sort.direction))
    errors["sort.direction"] = ["Sort ascending or descending."];

  if (Object.keys(errors).length > 0)
    throw new ReportQueryInvalidError("Review the highlighted report settings.", errors);

  return {
    dataset: dataset.key,
    fields: fields.length > 0 ? fields : dataset.fields.map((field) => field.key),
    filters,
    ...(input.groupBy ? { groupBy: input.groupBy } : {}),
    ...(input.sort
      ? { sort: { field: input.sort.field, direction: input.sort.direction as "asc" | "desc" } }
      : {}),
    limit: Math.min(Math.max(input.limit ?? DEFAULT_REPORT_PAGE, 1), MAX_REPORT_PAGE),
    offset: Math.max(input.offset ?? 0, 0),
  };
}

export type ReportRow = Record<string, string | number | null>;

export interface ReportResult {
  readonly dataset: ReportDatasetKey;
  readonly fields: readonly ReportField[];
  readonly rows: readonly ReportRow[];
  /** Rows matching the filters, before paging. What a "1–50 of 218" line is built from. */
  readonly totalRows: number;
  readonly groups: readonly { readonly value: string; readonly count: number }[];
  /** Execution metadata the issue asks for: what it cost and what it withheld. */
  readonly meta: {
    readonly scannedRows: number;
    readonly limit: number;
    readonly offset: number;
    /** Fields masked because the caller did not hold — or did not ask for — PII. */
    readonly maskedFields: readonly string[];
  };
}

const text = (value: string | number | null): string =>
  value === null ? "" : typeof value === "number" ? String(value) : value;

function matches(row: ReportRow, filter: ReportFilter): boolean {
  const raw = row[filter.field] ?? null;
  const left = text(raw).toLowerCase();
  const right = (filter.value ?? "").toLowerCase();
  switch (filter.operator) {
    case "equals":
      return left === right;
    case "not-equals":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "starts-with":
      return left.startsWith(right);
    case "greater-than":
      // Numeric where both sides are numbers, lexical otherwise — which is what makes it work
      // for an ISO date without a second operator nobody would know to choose.
      return typeof raw === "number" && !Number.isNaN(Number(right))
        ? raw > Number(right)
        : text(raw) > (filter.value ?? "");
    case "less-than":
      return typeof raw === "number" && !Number.isNaN(Number(right))
        ? raw < Number(right)
        : text(raw) < (filter.value ?? "");
    case "is-empty":
      return left === "";
    case "is-not-empty":
      return left !== "";
  }
}

/**
 * Mask a value that is personal data.
 *
 * Enough of it survives to tell two rows apart — an operator triaging a failed send needs to know
 * the messages went to different people — and not enough to reach anybody. This is deliberately
 * not a hash: a hash is stable across reports and therefore a join key onto the very data the
 * masking exists to withhold.
 */
export function maskValue(value: string | number | null): string {
  const raw = text(value);
  if (!raw) return "";
  const at = raw.indexOf("@");
  if (at > 0) return `${raw.slice(0, 1)}…@${raw.slice(at + 1)}`;
  return raw.length <= 2 ? "…" : `${raw.slice(0, 1)}…${raw.slice(-1)}`;
}

/**
 * Answer a validated query over rows the owning domain already authorized.
 *
 * Pure, and deliberately so: every input is a value, so the whole of filtering, grouping, sorting,
 * paging and masking can be asserted without a database, a session or a domain service. The
 * authorization happened before the rows arrived.
 */
export function runQuery(
  query: ReportQuery,
  rows: readonly ReportRow[],
  options: { includePii: boolean },
): ReportResult {
  const dataset = datasetOf(query.dataset);
  if (!dataset) throw new ReportQueryInvalidError("Unknown dataset");
  if (rows.length > MAX_REPORT_SCAN) throw new ReportTooExpensiveError(rows.length);

  const selected = dataset.fields.filter((field) => query.fields.includes(field.key));
  const masked = options.includePii ? [] : selected.filter((field) => field.pii);
  const maskedKeys = new Set(masked.map((field) => field.key));

  // Filtering happens on the *unmasked* values, and that is a decision rather than an oversight:
  // a report filtered on a masked value would answer differently depending on who ran it, which
  // makes a saved report mean two things. Masking is about what leaves, not about what matches.
  const matched = rows.filter((row) => query.filters.every((filter) => matches(row, filter)));

  const sorted = query.sort
    ? [...matched].sort((left, right) => {
        const field = query.sort as { field: string; direction: "asc" | "desc" };
        const a = left[field.field] ?? null;
        const b = right[field.field] ?? null;
        const order =
          typeof a === "number" && typeof b === "number" ? a - b : text(a).localeCompare(text(b));
        return field.direction === "asc" ? order : -order;
      })
    : matched;

  const groups = query.groupBy
    ? [
        ...sorted
          .reduce((counts, row) => {
            const key = text(row[query.groupBy as string] ?? null) || "(none)";
            counts.set(key, (counts.get(key) ?? 0) + 1);
            return counts;
          }, new Map<string, number>())
          .entries(),
      ]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    : [];

  const page = sorted.slice(query.offset, query.offset + query.limit).map((row) => {
    const projected: ReportRow = {};
    for (const field of selected)
      projected[field.key] = maskedKeys.has(field.key)
        ? maskValue(row[field.key] ?? null)
        : (row[field.key] ?? null);
    return projected;
  });

  return {
    dataset: query.dataset,
    fields: selected,
    rows: page,
    totalRows: matched.length,
    groups,
    meta: {
      scannedRows: rows.length,
      limit: query.limit,
      offset: query.offset,
      maskedFields: masked.map((field) => field.key),
    },
  };
}
