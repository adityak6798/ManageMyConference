# Review suggestions: configuration and operations

Status: canonical | Owner: review | IDs: `PORT-AI`, `PRD-AI-001` | Last verified: 2026-08-13

How AI-drafted review suggestions are produced, what has to be configured, what an operator does
when the assistant fails, and — stated plainly below — what has not been verified against a live
API.

## The one rule everything else serves

**A suggestion is a draft. It becomes part of the record only when a reviewer says so, and it never
completes an evaluation.**

That is `PRD-AI-001` expressed as three separate mechanisms rather than as a convention:

1. **Storage.** `review_suggestions` is a sibling of `review_evaluations`, not columns on it.
   Nothing that computes `review_outcomes` joins it, so no query can fold a draft into an
   aggregate. A suggestion leaves `offered` only with a named responder — migration `1310`'s
   `CHECK` enforces that, not the service.
2. **Two human actions.** Accepting a suggestion writes the reviewer's evaluation as a **draft**.
   Completing it is a separate act, and only completion moves an aggregate or emits
   `EVT-REVIEW-COMPLETED`.
3. **Provenance that cannot be fabricated.** An evaluation marked `source = 'suggested'` must name
   a suggestion belonging to the same assignment *and* the same reviewer; a trigger in `1310`
   refuses anything else.

The negatives are asserted rather than described: `apps/api/test/review-suggestions.test.ts`
("accepting produces a draft the reviewer still has to complete") checks that `listOutcomes` is
still empty after acceptance, and `d1-review-repository.integration.test.ts` drives the two
storage guards against real D1.

## The three modes

`REVIEW_AI_PROVIDER` selects the port on the request that asks for a suggestion, in
`apps/api/src/adapters/suggestions/configuration.ts`.

| Mode | Provider | Needs a credential | Used by |
|---|---|---|---|
| `fixture` (default) | `DeterministicSuggestionProvider` | no | local development, `npm run check`, the D1 suite, Playwright, the demo |
| `live` | `AnthropicSuggestionProvider` | yes, `REVIEW_AI_API_KEY` | a deployment that really drafts |
| `off` | none | no | a deployment that withdraws the assistant entirely |

`off` is a real mode, not an absence: with it the reviewer's queue offers no Draft control, the
suggestion routes answer `404`, and every other review behaviour is what it was before this
feature existed. That is what makes "the whole review workflow still works with the port switched
off" a state somebody can select and check.

There is **no fallback**. A `live` mode with no key throws naming the binding; it never quietly
drafts with the fixture. The failure this prevents is a deployment that believes a model is
drafting suggestions while a hash function actually is — with the provenance line on screen saying
a model did. For the same reason `fixture` is refused when `ENVIRONMENT` names a production
deployment (`production`, `prod` or `live`, in any case).

### Where the throw lands, precisely

Resolution happens on the request that asks for a suggestion, and the composition root
(`apps/api/src/index.ts`) **catches** a configuration failure rather than letting it escape. A
misconfigured deployment therefore deploys cleanly, serves every route including the reviewer's
queue, and fails only the Draft button — with `PROVIDER_UNCONFIGURED` on the reviewer's screen and
the binding name in the Worker log under `review.suggestions.misconfigured`.

This is deliberately the opposite trade from `COMMUNICATIONS_PROVIDERS`, where a misconfigured
`live` is allowed to throw into the scheduled drain. There, throwing is how a deployment avoids
believing it has sent mail. Here, nothing is claimed to have happened if the port never answers,
so the safe direction is to keep the rest of review working. **Check the logs, not the screen,**
when a `live` deployment's Draft button fails immediately.

## Configuration

| Binding | Mode | Secret | Meaning |
|---|---|---|---|
| `REVIEW_AI_PROVIDER` | all | no | `fixture` (default), `live`, or `off` |
| `REVIEW_AI_API_KEY` | live | **yes** | Anthropic API key. `npx wrangler secret put REVIEW_AI_API_KEY` |
| `REVIEW_AI_MODEL` | live | no | Pins the model. Defaults to `claude-opus-5` in the adapter |

### Least privilege

An Anthropic API key scoped to one workspace, with the lowest spend limit that covers expected
drafting volume. The adapter calls exactly one endpoint (`POST /v1/messages`) and needs nothing
else — no Files, no Batches, no Admin. Rotate by `wrangler secret put` and redeploying; there is
nothing in flight to lose, because a suggestion request either answers within its deadline or the
reviewer scores by hand.

### What crosses the boundary

The request carries the abstract's title, body and visible form answers, the rubric, and the round
number. It carries **no submitter name or address**: `SuggestionRequest` has no field for one, and
the service passes the same masked projection the reviewer's queue renders. Blind review therefore
holds against a live provider by construction rather than by care — asserted in
`review-suggestions.test.ts` ("never sends the submitter's identity across the port") and in the
adapter's own contract test.

It also carries no reviewer identity. A provider cannot be asked to draft "what this reviewer would
say", and a prompt cannot leak who is reviewing what.

## Normalized outcomes

Every failure reaches the reviewer as one of these codes, and never as provider text. The route
answers `502 UPSTREAM_UNAVAILABLE` with the code in `fieldErrors.suggestion`.

| Code | Cause | What the reviewer is told | Worth retrying |
|---|---|---|---|
| `PROVIDER_TIMEOUT` | our 20s ceiling (the adapter's own `AbortSignal.timeout`, or the service backstop), or a 408 | the assistant did not answer in time | yes |
| `PROVIDER_RATE_LIMITED` | 429 | the assistant is busy | yes |
| `PROVIDER_UNAVAILABLE` | 5xx | the assistant is unavailable | yes |
| `PROVIDER_UNREACHABLE` | DNS, TLS, dropped connection | the assistant could not be reached | yes |
| `PROVIDER_UNAUTHORIZED` | 401/403 | not configured correctly here — tell an organizer | no |
| `PROVIDER_UNCONFIGURED` | `live` with a missing binding | the same sentence | no |
| `PROVIDER_REJECTED` | any other 4xx | the generic sentence | no |
| `PROVIDER_REFUSED` | `stop_reason: "refusal"` | the assistant declined to draft for this abstract | no |
| `MALFORMED_PROVIDER_RESPONSE` | 2xx we cannot use | the assistant returned something unusable | no |

Deliberately a separate table from `providers/http-outcome.ts` even though the vocabulary rhymes:
those codes are stored on immutable delivery attempts and read by organizers, while these are
transient and read by a reviewer mid-task. One vocabulary answering to two audiences is how a
message ends up wrong for both.

**Every one of them leaves the manual path untouched.** That is the whole failure design, and it is
asserted at three levels: the service (the reviewer completes an evaluation after a timeout), the
route (`502`, then a successful `PUT .../evaluation`), and the rendered card (the notice appears
beside an enabled form).

## The deadline

20 seconds, in `review-service.ts`. Longer than the outbox's ten, deliberately: that ceiling
protects a scheduled drain working through a hundred deliveries, while this one is a person
watching a spinner.

Two layers enforce it. The adapter passes `AbortSignal.timeout`, which is what actually releases
the connection; the service races the call as a backstop for an implementation that ignores its
own deadline. The same relationship the outbox's lease has with its per-call ceiling.

## The fixture, and why it says so

`DeterministicSuggestionProvider` derives every value from an FNV-1a hash of the abstract's text,
so the same abstract and rubric produce byte-identical output on every machine and every run —
which is what lets the browser suite assert the drafted value itself rather than that *some* number
appeared.

It does not pretend to be intelligent, and it says so in its own output: the summary ends "no model
read this abstract" and each rationale states that the value came from a hash. A fixture that
produced plausible-sounding reasoning would invite a demo to be read as evidence the feature works,
which is the overclaim `GAP-011` exists to prevent.

Both failure modes are reachable without a network — `new DeterministicSuggestionProvider("timeout")`
and `("error")` — which is how the degradation path is tested at every level.

## Staging smoke — completed 2026-08-13

No Anthropic credential exists in this repository. The request shape was built from the Messages
API's documented contract, and `apps/api/test/suggestion-provider.test.ts` stubs `fetch` — it
proves our normalization, not their API.

On 2026-08-13, commit `83c757389a2468500172fc2a5f7aeeeb46497345` was deployed to the
temporary Worker `project-greenroom-ai-staging`, backed by dedicated D1 and R2 staging resources.
A workspace key held outside the repository was installed as a Worker secret. No credential,
provider response body, or generated prose was stored or committed. The serving model was
`claude-opus-5`; the stored prompt version was `review-suggestion/v1`.

The checklist completed as follows:

1. With `REVIEW_AI_PROVIDER=live` and no key, deployment and queue loading succeeded. Drafting
   answered `502 UPSTREAM_UNAVAILABLE` with `PROVIDER_UNCONFIGURED`; manual evaluation still saved.
2. With the secret installed, a deployed draft returned `201` and persisted a nonempty summary,
   exactly one numeric, dropdown, and text score in its criterion's allowed shape, nonempty
   rationales, proposal revision, model, and prompt version.
3. Accepting that suggestion produced a `source = suggested` evaluation in `draft` state. D1 held
   no `review_outcomes` row. A separate `complete: true` evaluation request changed the state to
   completed and only then produced the aggregate (`completed_evaluation_count = 1`).
4. Replacing the secret with a revoked value made drafting answer `PROVIDER_UNAUTHORIZED`; manual
   evaluation still saved. The valid secret was restored afterward.
5. A live safety-classifier request returned HTTP 200 with Anthropic `stop_reason = refusal`; the
   production adapter normalized it to `PROVIDER_REFUSED`. Manual fallback is the same independent
   evaluation route exercised in the missing- and revoked-key cases and covered at service, HTTP,
   and rendered-card levels.
6. The live request was intercepted immediately before the same fetch was forwarded. Its top-level
   fields were `max_tokens`, `messages`, `model`, `output_config`, and `system`; it contained no
   submitter field, known submitter name, or address.

No request-shape correction was required after deployment. Earlier pre-deployment attempts exposed
only account credit propagation, correctly normalized to `PROVIDER_REJECTED`. This run closes the
live-verification part of `GAP-011`; deployment credentials remain operator-owned and `fixture`
remains the safe default for local development and CI.

## Why raw `fetch` rather than the Anthropic SDK

The official SDK is the better default for an ordinary Node service and was the first thing tried.
It pulls `node:fs` and `node:path` into the bundle for its credential-chain support, which a Worker
resolves only with the `nodejs_compat` compatibility flag — a runtime change affecting every route
in the deployment, to serve one adapter that is off by default. The other three live adapters here
already speak raw `fetch`, the adapters layer has an enforced external-package allowlist, and the
delivery contract suite proves those adapters by stubbing `fetch`. Matching that shape leaves the
Worker's compatibility surface untouched and makes this adapter testable the way its siblings are.

Revisit if the Worker ever needs `nodejs_compat` for its own reasons; at that point the SDK becomes
the cheaper option and this note is the record of why it was not taken first.
