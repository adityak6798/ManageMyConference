/** Content-owned AI seam. It returns prose and has no storage dependency or write method. */
export interface ContentRemixPort {
  remix(input: {
    kind: "speaker-bio" | "session-abstract";
    source: string;
    instruction: string;
  }): Promise<{ text: string; model: string }>;
}
