/*
 * The fourth signed-out surface: what Greenroom offers a program rather than a person.
 *
 * It exists because the marketing page listed nine capabilities and not one of them mentioned
 * that the console is a client of a public HTTP contract, and because the *reference* — the
 * generated operation browser at `/docs` and the document behind it at `/openapi.json` — was
 * reachable only from the README. A reader deciding whether Greenroom can be automated had to
 * read the repository to find out that it can.
 *
 * This page is the argument; `/docs` is the reference. It deliberately does not restate the
 * operations one by one, because a hand-written endpoint list is a second source of truth that
 * goes stale the first time a route moves. It states the rules that hold across all of them — how a request
 * is authenticated, what a failure looks like, what may change under a client and with how much
 * notice — and then hands the reader to the generated document.
 *
 * The same honesty rule the capability ledger follows applies here, and it costs something on
 * this page: machine credentials are resolved only on a deployment that is not in demo mode
 * (`transport/http/app.ts` takes the persona branch first), and the seeded demo everyone
 * evaluates *is* in demo mode. So the credential row says so on its own row rather than letting
 * a reader discover it from a 401.
 *
 * Every figure here that is a count of something in the repository is asserted against
 * `packages/contracts/openapi.json` by `test/api-page.test.tsx`. The document is 3.5 MB and is
 * not imported into this bundle; the test is what keeps the prose true.
 */

import { apiBase } from "../api/config";
import { useLinkProps } from "../router";

/**
 * What the generated document contains, as of the commit that ships this page.
 *
 * Restated here rather than derived, because deriving it would mean shipping a 3.5 MB JSON
 * document to every reader of a marketing page. `test/api-page.test.tsx` reads the real document
 * and fails when either number drifts, which is the only reason they are allowed to be literals.
 */
export const CONTRACT = {
  operations: 205,
  paths: 165,
  /** `/api/public/*`, split the way the page describes it: what may be read, and what may be sent. */
  publicReads: 7,
  publicWrites: 5,
  capabilities: 13,
  version: "0.1.0",
  openapi: "3.0.3",
} as const;

/**
 * The code the failure sample prints.
 *
 * Exported so `test/api-page.test.tsx` can hold it to `apiErrorCodeSchema`. The sample first
 * printed `TIMEZONE_REJECTED`, taken from the compatibility policy's prose — where it names a
 * *field error*, not a code. A documented error code the API cannot return is the one kind of
 * mistake on this page that a reader only discovers by writing the handler for it.
 */
export const ERROR_SAMPLE_CODE = "VALIDATION_FAILED";

/** Where the generated reference lives. Absolute paths on the Worker that serves this document. */
const REFERENCE_PATH = "/docs";
const DOCUMENT_PATH = "/openapi.json";

/**
 * The origin a reader should paste into a terminal.
 *
 * `apiBase` is empty on the same-origin Worker deployment — which is the deployed
 * configuration, since `wrangler.toml` serves this bundle and runs the Worker first for
 * `/api/*`, `/health`, `/openapi.json` and `/docs` — and set only when the frontend is hosted
 * apart from the API. Falling back to the document's own origin means the sample is copyable
 * from wherever it is being read instead of naming one deployment forever.
 */
function apiOrigin(): string {
  if (apiBase) return apiBase;
  return typeof window === "undefined" ? "https://greenroom.example" : window.location.origin;
}

/** A reference link, which is on the API origin rather than necessarily on this one. */
const referenceHref = (path: string) => `${apiBase}${path}`;

type Door = {
  title: string;
  /** The one-line answer to "when is this the right credential?" */
  when: string;
  body: string;
  /** Stated on its own row when the credential does not work everywhere this build runs. */
  qualifier?: string;
};

const doors: readonly Door[] = [
  {
    title: "No credential at all",
    when: "The published programme",
    body: `${CONTRACT.publicReads} reads under /api/public/* answer without any credential: the published event and its multi-day schedule, the call for proposals, a portal and one of its custom pages, a shared itinerary, and a configured embed. They resolve one versioned publishing projection, so a schedule publish moves all of them together; a 200 carries a strong ETag and no-cache, and they are readable cross-origin, so a browser can call them directly. ${CONTRACT.publicWrites} writes are open too, because the people who make them do not have accounts: submitting a proposal, saving and updating an itinerary, registering through a portal, and resolving a shared report. Each of those is authorized by an unguessable token or by the submission window rather than by a session.`,
    qualifier:
      "They are bounded by publication rather than by permission. An unpublished event answers these routes exactly as an unknown slug does, which is the point of them.",
  },
  {
    title: "A machine credential",
    when: "Anything server-to-server",
    body: `An organization issues a bearer credential of the form grn_<prefix>.<secret> and grants it a subset of the ${CONTRACT.capabilities} capabilities plus an explicit allowlist of the events it may touch — so a credential built to read a schedule cannot read the CRM, and cannot reach next year's event either. Only a SHA-256 digest of the secret is stored: the plaintext is returned once, by the create or the rotate that minted it, and no later screen or route can show it again. An expiry is optional, rotation keeps the previous secret valid for 24 hours so a deploy does not have to be atomic, and revocation takes effect on the next request.`,
    qualifier:
      "Bearer credentials are resolved on a deployment that is not in demo mode. The seeded demo authenticates personas by cookie and takes that branch first, so a credential issued there is stored and shown but never accepted — issue #12 is the graduation that turns this deployment into one that would honour it.",
  },
  {
    title: "The console's own session cookie",
    when: "A person in a browser",
    body: "The console signs in and receives an httpOnly session cookie, and every operation this page describes is one the console reaches with it. That is the useful fact about it: there is no private console API. It is not a server-to-server credential, though — it is httpOnly by design, cannot be read out of a browser, and carries whatever the signed-in person happens to hold rather than a scope somebody chose deliberately.",
  },
];

/**
 * The rules that hold across every operation, which is what a client author actually needs.
 *
 * Four, and each one is a thing a caller has to write code for: what a failure looks like, how a
 * retry is made safe, how a long list is walked, and what is allowed to change underneath them.
 */
const rules: readonly [string, string][] = [
  [
    "One failure shape",
    "Every non-2xx response is { error: { code, message, correlationId } }, with fieldErrors naming the request fields when validation is what refused. The same correlation id is on the x-correlation-id header of every response, successful ones included, so an operator can be handed one string and find the request.",
  ],
  [
    "Retries you can make safe",
    "A mutation that documents Idempotency-Key implements it: the key is scoped to the authenticated tenant and the operation, reuse with different input is refused with 409 CONFLICT rather than quietly doing something else, and the original response is replayed. Creating or rotating a credential is the deliberate exception — its response is a plaintext secret Greenroom does not retain, so a retry there is a new credential rather than a replay.",
  ],
  [
    "Cursors, not offsets",
    "A paged collection accepts limit and an opaque cursor and returns nextCursor, which is null on the last page. The cursor is not to be parsed, synthesized, or reused with different filters, and each operation documents its own default and maximum page size. One collection is paged today — the communications delivery history; this is the shape the next one will take, not a description of every list.",
  ],
  [
    "A version on every response",
    `Greenroom-API-Version: ${CONTRACT.version} on every response, and the same declared constant is the generated document's info.version. It says what the deployment implements; it is not content negotiation, and a request cannot ask for a different version.`,
  ],
];

/**
 * What is allowed to change, and what a client is owed when it does.
 *
 * This is the section a reader building against the API is looking for, and the last sentence is
 * the one this repository is unusual for printing: the procedure exists and no endpoint has been
 * through it, which is a fact about the product's age rather than about its policy.
 */
const compatible: readonly string[] = [
  "a new endpoint",
  "a new optional request field or header",
  "a new response field",
  "a new member of a response-only enum",
  "wider accepted input, when existing requests keep their meaning",
];

export function ApiSurface() {
  const linkProps = useLinkProps();
  const origin = apiOrigin();
  return (
    <>
      <div className="landing-hero is-single">
        <div className="landing-hero-copy">
          <h1>Greenroom is an API with a console on top of it.</h1>
          <p className="landing-lede">
            Every screen in the product is drawn by calling the same public HTTP contract you get:{" "}
            {CONTRACT.operations} operations across {CONTRACT.paths} paths, described by one OpenAPI{" "}
            {CONTRACT.openapi} document that is generated from the very schemas the server validates
            requests with — so the reference cannot describe a route the deployment does not
            implement.
          </p>
          <div className="landing-doors">
            <a className="landing-door" href={referenceHref(REFERENCE_PATH)}>
              Browse the API reference
            </a>
            <a className="landing-door secondary" href={referenceHref(DOCUMENT_PATH)}>
              Download the OpenAPI document
            </a>
          </div>
          <p className="landing-fineprint">
            The reference is served by the deployment itself and loads no third-party runtime, so
            what it lists is what that deployment answers. Continuous integration rejects any drift
            between the document and the schemas.
          </p>
        </div>
      </div>

      <section className="landing-section" aria-labelledby="api-start-title">
        <div className="landing-section-head">
          <h2 id="api-start-title">Start without an account</h2>
          <p>
            The published programme needs no credential, so the first call can be made from a
            terminal before anybody has signed up for anything.
          </p>
        </div>
        <pre className="landing-sample">
          <code>{`curl -sS "${origin}/api/public/events/greenroom-demo-summit/schedule"`}</code>
        </pre>
        <p className="landing-section-note">
          The same shape, with a credential, reaches the operations a person needs permission for.
        </p>
        <pre className="landing-sample">
          <code>{`curl -sS "${origin}/api/events/$EVENT_ID/overview" \\
  -H "Authorization: Bearer grn_<prefix>.<secret>"`}</code>
        </pre>
      </section>

      <section className="landing-section" id="authentication" aria-labelledby="api-doors-title">
        <div className="landing-section-head">
          <h2 id="api-doors-title">Three ways a request is authenticated</h2>
          <p>
            Which one to use is decided by what is calling, not by what is being called. The limits
            of each are here rather than in a 401.
          </p>
        </div>
        <ul className="landing-ledger">
          {doors.map((door) => (
            <li key={door.title}>
              <div className="landing-ledger-head">
                <h3>{door.title}</h3>
                <p className="landing-ledger-when figure">{door.when}</p>
              </div>
              <div className="landing-ledger-body">
                <p>{door.body}</p>
                {door.qualifier ? <p className="landing-ledger-note">{door.qualifier}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="api-rules-title">
        <div className="landing-section-head">
          <h2 id="api-rules-title">Four rules that hold everywhere</h2>
          <p>
            Each of these is something a client has to write code for once rather than per endpoint.
          </p>
        </div>
        {/* Two columns, not the four the marketing page's pillars use. These four are paragraphs
            rather than one-liners, and 60 words in a 270px column is a column nobody reads. */}
        <div className="landing-columns">
          {rules.map(([title, body]) => (
            <article key={title}>
              <h3 className="landing-column-title">{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
        {/* The code is `ERROR_SAMPLE_CODE` rather than a literal so the sample cannot print a
            code the contract does not declare — which the first draft of this page did. */}
        <pre className="landing-sample">
          <code>{`{
  "error": {
    "code": "${ERROR_SAMPLE_CODE}",
    "message": "The event time zone is not a zone this deployment can resolve.",
    "correlationId": "01J8Z9F7QK3M0S1V2W3X4Y5Z6A",
    "fieldErrors": { "timezone": ["Choose a named IANA time zone."] }
  }
}`}</code>
        </pre>
      </section>

      <section className="landing-section" id="webhooks" aria-labelledby="api-webhooks-title">
        <div className="landing-section-head">
          <h2 id="api-webhooks-title">Events pushed to you, signed</h2>
          <p>
            An organization subscribes a URL to an event type and Greenroom delivers to it from a
            durable outbox: retried on a failure, replayable by hand, and readable as a delivery
            history with one attempt per row.
          </p>
        </div>
        <div className="landing-prose">
          <p>
            Each delivery carries{" "}
            <code>Greenroom-Signature: t=&lt;unix-seconds&gt;,v1=&lt;hex&gt;</code>, where the hex
            is HMAC-SHA256 over the exact string <code>&lt;t&gt;.&lt;body&gt;</code> under the
            subscription secret. Verify the timestamp is within five minutes and compare the digest
            in constant time. A rotation sends two <code>v1=</code> values in the same header until
            the old secret expires, so a receiver can be redeployed after the rotation rather than
            during it. <code>Greenroom-Event-Id</code>, <code>Greenroom-Event-Type</code> and{" "}
            <code>Greenroom-Delivery-Id</code> travel beside it, and the event id is the
            deduplication key for a redelivery.
          </p>
          <p className="landing-ledger-note">
            One event type ships today — <code>schedule.published</code>, version 1, carrying the
            publication version and nothing else. The payload deliberately never carries speaker,
            proposal, reviewer or CFP content, so a subscription is not a way around the permissions
            on those records. Subscription create, update, disable, secret rotation and manual
            replay each require an <code>Idempotency-Key</code>.
          </p>
        </div>
      </section>

      <section className="landing-section" aria-labelledby="api-stability-title">
        <div className="landing-section-head">
          <h2 id="api-stability-title">What may change under you</h2>
          <p>
            Greenroom versions the contract rather than the URL, so resources stay where they are
            instead of moving behind a <code>/v2</code> the day something is added.
          </p>
        </div>
        <div className="landing-columns">
          <div>
            <h3 className="landing-column-title">Ships without a new version</h3>
            <ul className="landing-list">
              {compatible.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
            <p className="landing-section-note">
              Which is the contract a client owes in return: ignore response fields you do not use,
              and handle a response enum member you do not recognize.
            </p>
          </div>
          <div>
            <h3 className="landing-column-title">Requires notice</h3>
            <p>
              Removing or renaming a field or an endpoint, making input required, narrowing what is
              accepted, changing a type, changing the authorization a route needs, or repurposing a
              status or error code. A breaking replacement ships additively first; the old behaviour
              then answers with <code>Deprecation</code> and a <code>Sunset</code> date no earlier
              than 180 days out, and both contracts stay available together for at least that long.
            </p>
            <p className="landing-ledger-note">
              No Greenroom endpoint has been through that procedure yet. The policy and the
              always-on version header are implemented; a completed deprecation is not something
              this product can claim.
            </p>
          </div>
        </div>
      </section>

      <section className="landing-section landing-close" aria-labelledby="api-close-title">
        <h2 id="api-close-title">Read the operations</h2>
        <p>
          The reference lists every operation with its parameters, request and response schemas, and
          the statuses it actually returns. Nothing on this page replaces it.
        </p>
        <div className="landing-doors">
          <a className="landing-door" href={referenceHref(REFERENCE_PATH)}>
            Browse the API reference
          </a>
          <a className="landing-door secondary" {...linkProps("/")}>
            Back to the overview
          </a>
        </div>
      </section>
    </>
  );
}
