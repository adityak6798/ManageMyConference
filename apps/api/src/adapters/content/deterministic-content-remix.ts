import type { ContentRemixPort } from "../../application/content/content-remix-port";

/** Local/demo provider: visibly drafts a concise edit while preserving the source for review. */
export class DeterministicContentRemix implements ContentRemixPort {
  async remix(input: {
    kind: "speaker-bio" | "session-abstract";
    source: string;
    instruction: string;
  }) {
    const source = input.source.trim();
    const instruction = input.instruction.trim();
    return {
      text: instruction ? `${source}\n\nDrafting note: ${instruction}` : source,
      model: "greenroom-content-fixture-v1",
    };
  }
}
