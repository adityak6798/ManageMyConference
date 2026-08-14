/** Bounded codes are the only target-derived information returned to Greenroom. @spec PRD-INT-001 */
export class EgressError extends Error {
  constructor(
    readonly code: string,
    readonly disposition: "refused" | "retryable" | "terminal",
  ) {
    super(code);
    this.name = "EgressError";
  }
}
