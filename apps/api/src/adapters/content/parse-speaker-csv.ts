import Papa from "papaparse";

export interface SpeakerCsvRow {
  name: string;
  email: string;
  workflowStatus?: string | undefined;
  logistics?: string | undefined;
  customFields?: string | undefined;
}

export function parseSpeakerCsv(csv: string): {
  rows: SpeakerCsvRow[];
  errors: { row: number; message: string }[];
} {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  return {
    rows: parsed.data.map((row) => ({
      name: row.name?.trim() ?? "",
      email: row.email?.trim().toLowerCase() ?? "",
      workflowStatus: row.workflowStatus?.trim(),
      logistics: row.logistics?.trim(),
      customFields: row.customFields?.trim(),
    })),
    errors: parsed.errors.map((error) => ({ row: (error.row ?? 0) + 2, message: error.message })),
  };
}
