/*
 * Reading the Accelevents registration platform: the fixture everything runs on, and the live
 * client nothing has yet run.
 *
 * @spec PORT-ACCELEVENTS PRD-INT-001
 */
import type {
  AccelEventsRegistrant,
  AccelEventsRegistrationSource,
} from "../../application/communications/accelevents-sync";
import { AccelEventsUnavailableError } from "../../application/communications/accelevents-sync";
import { PROVIDER_TIMEOUT_MS, outcomeForStatus, readJsonBody } from "./http-outcome";

/**
 * The credential-free roster every local run, test, demo and CI sync reads.
 *
 * Deterministic and deliberately not all-valid. A fixture where every row imports cleanly makes
 * the failure path unreachable from the product: nobody can see what a bad registration looks
 * like without editing code. `no-email@` is malformed on purpose, so an organizer pressing
 * Preview in the demo sees a real invalid row, its reason, and that it is not imported — which is
 * also what `ACC-INTEGRATION`'s failure-surfacing criterion is asserted against.
 *
 * One address deliberately matches the seeded speaker `sam@example.test`, so the second run — and
 * the demo's first run — shows a `skip` and demonstrates convergence rather than duplication.
 */
export const FIXTURE_ATTENDEE_RESPONSE = {
  attendees: [
    {
      attendeeId: "ae-reg-1001",
      firstName: "Sam",
      lastName: "Speaker",
      email: "sam@example.test",
      ticketType: "Speaker",
      status: "ACTIVE",
      ticketStatus: "BOOKED",
      barcode: "fixture-1001",
    },
    {
      attendeeId: "ae-reg-1002",
      firstName: "Nadia",
      lastName: "Okafor",
      email: "nadia@example.test",
      ticketType: "Speaker",
      status: "ACTIVE",
      ticketStatus: "BOOKED",
      barcode: "fixture-1002",
    },
    {
      attendeeId: "ae-reg-1003",
      firstName: "Ravi",
      lastName: "Menon",
      email: "ravi.menon@example.test",
      ticketType: "Workshop lead",
      status: "ACTIVE",
      ticketStatus: "BOOKED",
      barcode: "fixture-1003",
    },
    {
      attendeeId: "ae-reg-1004",
      firstName: "Broken",
      lastName: "Record",
      email: "no-email@",
      ticketType: "Speaker",
      status: "ACTIVE",
      ticketStatus: "BOOKED",
      barcode: "fixture-1004",
    },
  ],
  recordsFiltered: 4,
  recordsTotal: 4,
  ticketTypeCountDtos: [
    { ticketTypeId: 1, ticketTypeName: "Speaker", totalTickets: 3 },
    { ticketTypeId: 2, ticketTypeName: "Workshop lead", totalTickets: 1 },
  ],
  totalBookedTickets: 4,
  totalCheckedInTickets: 0,
  totalFreeTickets: 4,
  totalPaidTickets: 0,
} as const;

const registrantsFrom = (body: unknown): readonly AccelEventsRegistrant[] | null => {
  if (!body || typeof body !== "object") return null;
  const envelope = body as Record<string, unknown>;
  if (
    !Array.isArray(envelope.attendees) ||
    !Number.isInteger(envelope.recordsTotal) ||
    (envelope.recordsTotal as number) < 0 ||
    !Number.isInteger(envelope.recordsFiltered) ||
    (envelope.recordsFiltered as number) < 0
  )
    return null;
  return envelope.attendees.flatMap((record): AccelEventsRegistrant[] => {
    const { attendeeId, firstName, lastName, email, ticketType } = (record ?? {}) as Record<
      string,
      unknown
    >;
    if (
      (typeof attendeeId !== "string" && typeof attendeeId !== "number") ||
      typeof firstName !== "string" ||
      typeof lastName !== "string" ||
      typeof email !== "string"
    )
      return [];
    const name = `${firstName} ${lastName}`.trim();
    if (!String(attendeeId) || !name || !email) return [];
    return [
      {
        sourceRef: String(attendeeId),
        name,
        email,
        ...(typeof ticketType === "string" && ticketType ? { ticketType } : {}),
      },
    ];
  });
};

export class FixtureAccelEventsRegistrations implements AccelEventsRegistrationSource {
  constructor(private readonly response: unknown = FIXTURE_ATTENDEE_RESPONSE) {}
  /**
   * The same roster whichever event asks.
   *
   * Safe only because this data is invented and lives in the repository. The live client below
   * must not behave this way, and does not — see `boundEventId`.
   */
  async listRegistrants(_eventId: string): Promise<readonly AccelEventsRegistrant[]> {
    const registrants = registrantsFrom(this.response);
    if (!registrants) throw new AccelEventsUnavailableError("MALFORMED_PROVIDER_RESPONSE");
    return registrants;
  }
}

export interface AccelEventsRegistrationClientConfiguration {
  /** Origin of the Accelevents API. The event path is appended to it. */
  readonly apiOrigin: string;
  readonly token: string;
  /** The Accelevents event whose registrations this deployment reads. */
  readonly eventRef: string;
  /**
   * The **Greenroom** event `eventRef` corresponds to.
   *
   * Without this the client would answer the same roster for every event, because `eventRef` is
   * one deployment-wide binding while `listRegistrants` is asked per event. An organizer holding
   * `content:manage` on an unrelated event would then import a different conference's attendee
   * names and addresses as speaker profiles on theirs — authorized, since they may sync *their*
   * event, and wrong, because the answer was never scoped to it. The capability check upstream
   * decides who may sync; this decides what they are allowed to receive.
   */
  readonly boundEventId: string;
  readonly timeoutMs?: number;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

// A live sync must have a finite request budget even when the provider returns a malicious or
// corrupt total. At the documented maximum page size this still permits 100,000 registrations.
const MAX_PAGE_REQUESTS = 1_000;

/**
 * The live registration client.
 *
 * **Never exchanged with the real API.** No Accelevents credential exists in this repository and
 * none was used: the request and response shapes below come from the documented integration
 * contract, not from an observed exchange, and the tests stub `fetch`. They prove this adapter's
 * normalization, not Accelevents' API. Before this is enabled anywhere real, someone with a
 * sandbox tenant has to run the staging smoke in `docs/engineering/communications-providers.md`
 * and correct whatever the API actually wants.
 *
 * A record missing an id, a name or an address is dropped rather than imported as a blank person;
 * dropping it is visible as a smaller total, where importing it would be a speaker nobody can
 * reach.
 */
export class HttpAccelEventsRegistrations implements AccelEventsRegistrationSource {
  constructor(
    private readonly configuration: AccelEventsRegistrationClientConfiguration,
    private readonly fetch: Fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async listRegistrants(eventId: string): Promise<readonly AccelEventsRegistrant[]> {
    // Refused rather than answered with the wrong conference's roster. One deployment maps one
    // Greenroom event to one Accelevents event; anything else is a configuration question, and
    // answering it by returning whatever `ACCELEVENTS_EVENT_REF` happens to name would import
    // other people's names and addresses into this event's speaker list.
    if (eventId !== this.configuration.boundEventId)
      throw new AccelEventsUnavailableError("ACCELEVENTS_EVENT_NOT_MAPPED");
    const baseUrl = `${this.configuration.apiOrigin.replace(/\/$/, "")}/rest/events/${encodeURIComponent(
      this.configuration.eventRef,
    )}/staff/allAttendees`;
    const registrants: AccelEventsRegistrant[] = [];
    const pageSize = 100;
    let page = 0;
    let recordsFiltered: number | null = null;
    let providerRowsSeen = 0;
    while (recordsFiltered === null || providerRowsSeen < recordsFiltered) {
      if (page >= MAX_PAGE_REQUESTS)
        throw new AccelEventsUnavailableError("MALFORMED_PROVIDER_RESPONSE");
      const url = `${baseUrl}?page=${page}&size=${pageSize}&dataType=TICKET`;
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: "GET",
          headers: {
            AUTHENTICATION: this.configuration.token,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.configuration.timeoutMs ?? PROVIDER_TIMEOUT_MS),
        });
      } catch {
        // ERROR-INTENT: transport failures carry untrusted text that can name internal hosts; only
        // the normalized code survives.
        throw new AccelEventsUnavailableError("PROVIDER_UNREACHABLE");
      }
      const failure = outcomeForStatus(response.status);
      if (failure && failure.kind !== "success")
        throw new AccelEventsUnavailableError(failure.code);
      const body = await readJsonBody(response);
      const parsed = registrantsFrom(body);
      if (!parsed || !body || typeof body !== "object")
        throw new AccelEventsUnavailableError("MALFORMED_PROVIDER_RESPONSE");
      const pageRecordsFiltered = (body as { recordsFiltered: number }).recordsFiltered;
      if (recordsFiltered !== null && pageRecordsFiltered !== recordsFiltered)
        throw new AccelEventsUnavailableError("MALFORMED_PROVIDER_RESPONSE");
      recordsFiltered = pageRecordsFiltered;
      const providerRows = (body as { attendees: unknown[] }).attendees.length;
      providerRowsSeen += providerRows;
      if (providerRowsSeen > recordsFiltered)
        throw new AccelEventsUnavailableError("MALFORMED_PROVIDER_RESPONSE");
      registrants.push(...parsed);
      if (providerRows === 0 && providerRowsSeen < recordsFiltered)
        throw new AccelEventsUnavailableError("MALFORMED_PROVIDER_RESPONSE");
      page += 1;
    }
    return registrants;
  }
}
