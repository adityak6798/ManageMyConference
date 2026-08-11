export type CfpFieldType = "short_text" | "long_text" | "email" | "select";
export interface CfpField {
  readonly id: string;
  readonly type: CfpFieldType;
  readonly label: string;
  readonly guidance: string;
  readonly required: boolean;
  readonly options: readonly string[];
}
export interface CfpForm {
  readonly eventId: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly CfpField[];
  readonly status: "draft" | "open" | "closed";
  readonly version: number;
  readonly publishedAt: string | null;
  readonly publishedStatus: "open" | "closed" | null;
}
export interface ProposalSubmission {
  readonly id: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly idempotencyKey: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly fields: readonly CfpField[];
  readonly submittedAt: string;
}
