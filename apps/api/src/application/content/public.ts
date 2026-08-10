// @spec PRD-CNT-001 PRD-AGD-001
export interface SchedulableSessionView {
  readonly id: string;
  readonly title: string;
  readonly speakerIds: readonly string[];
}
export interface SchedulableContentQuery {
  forEvent(eventId: string): Promise<readonly SchedulableSessionView[]>;
}
export class FixtureSchedulableContentQuery implements SchedulableContentQuery {
  constructor(private readonly data: ReadonlyMap<string, readonly SchedulableSessionView[]>) {}
  async forEvent(eventId: string) {
    return structuredClone(this.data.get(eventId) ?? []);
  }
}
