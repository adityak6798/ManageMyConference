// Type surface for `worktree-env.mjs`, which is plain JavaScript because the local
// entrypoints that call it (npm scripts, Vite and Playwright config) run it without a build
// step. Declared here so `apps/web` can import it under `allowJs: false`.

export interface WorktreeEnvironment {
  /** Absolute path of the checkout this process belongs to. */
  root: string;
  /** Ports the checkout path hashes to, before any override is applied. */
  derivedApiPort: number;
  derivedWebPort: number;
  /** Ports actually in effect. */
  apiPort: number;
  webPort: number;
  apiPortSource: "derived" | "override";
  webPortSource: "derived" | "override";
  /** Per-instance local state, keyed on the API port. */
  instanceDir: string;
  stateDir: string;
  configHome: string;
  logPath: string;
  migrationRecordPath: string;
  migrationsDir: string;
  playwrightOutputDir: string;
  playwrightReportDir: string;
}

export interface MigrationIdentity {
  names: string[];
  files: Record<string, string>;
  digest: string;
}

/** Which checkout started a server, and at which commit. */
export interface BuildIdentity {
  root: string;
  commit: string;
}

export interface IdentityProbe {
  label: string;
  url: string;
}

export const PORT_BLOCK_BASE: number;
export const PORT_BLOCK_COUNT: number;

export function worktreeRoot(cwd?: string): string;
export function headCommit(cwd?: string): string;
/** The server's reported identity, `undefined` if it reports none, `null` if nothing answers. */
export function probeServerIdentity(url: string): Promise<BuildIdentity | undefined | null>;
export function describeServerIdentityMismatch(
  expected: BuildIdentity,
  actual: BuildIdentity | undefined | null,
  probe: IdentityProbe,
): { fatal: string | null; warning: string | null };
export function derivePorts(root: string): { apiPort: number; webPort: number };
export function resolveWorktreeEnvironment(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
  cwd?: string,
): WorktreeEnvironment;
export function migrationIdentity(migrationsDir: string): MigrationIdentity;
export function readMigrationRecord(recordPath: string): MigrationIdentity | null;
export function writeMigrationRecord(recordPath: string, identity: MigrationIdentity): void;
export function staleMigrationDiagnostic(
  recorded: MigrationIdentity | null,
  current: MigrationIdentity,
  environment: WorktreeEnvironment,
): string | null;
export function statusReport(environment: WorktreeEnvironment): string;
