/**
 * The result contract for a D1 write whose correctness depends on the affected-row count.
 *
 * A successful conditional write with no matching row and a write that landed are both
 * `success: true`; `meta.changes` is the only distinction. The count is therefore required at
 * this boundary. A driver that omits it has violated the adapter contract and must be refused,
 * never interpreted as either zero rows or an applied write.
 */
export interface D1WriteResult {
  success: boolean;
  error?: string;
  meta: { changes: number };
}

export function changedRows(result: D1WriteResult, operation: string): number {
  if (typeof result.meta?.changes !== "number")
    throw new Error(`D1 reported no row count while attempting to ${operation}`);
  return result.meta.changes;
}
