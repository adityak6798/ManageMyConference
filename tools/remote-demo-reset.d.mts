// Type surface for `remote-demo-reset.mjs`, which is plain JavaScript because it is an npm-script
// entrypoint (`npm run reset:demo`) that runs without a build step. Declared here so the D1
// integration test can drive the *shipped* guard against a real seeded database under
// `allowJs: false`, rather than a copy of its SQL that could drift from it.

/** The tables the demo restore empties and refills, in the order the refusal reports them. */
export const GUARDED_TABLES: readonly ["organizations", "events", "users"];

export type GuardedTable = (typeof GUARDED_TABLES)[number];
export type SeededFixtureIds = Record<GuardedTable, string[]>;
export type UnseededCounts = Record<GuardedTable, number>;

export const DEMO_TARGET: {
  readonly worker: string;
  readonly databaseBinding: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly bucketBinding: string;
  readonly bucketName: string;
  readonly assetPath: string;
};

export function assertDemoConfig(text: string): void;
export function seededFixtureIds(sql: string): SeededFixtureIds;
export function unseededCountQuery(ids: SeededFixtureIds): string;
export function unseededCountCommand(ids: SeededFixtureIds): string[];
export function parseUnseededCounts(stdout: string): UnseededCounts;
export function destroyToken(counts: UnseededCounts): string;
export function assertOnlySeededData(counts: UnseededCounts, override: string | undefined): void;
export function remoteResetCommands(): string[][];
export function parseArguments(argv: string[]): {
  confirm: string | undefined;
  destroy: string | undefined;
};
export function readUnseededCounts(runner?: (command: string[]) => string): UnseededCounts;
export function main(
  argv?: string[],
  seams?: { run?: (command: string[]) => void; capture?: (command: string[]) => string },
): void;
