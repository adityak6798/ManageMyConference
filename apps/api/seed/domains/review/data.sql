

-- The seeded content sessions are program content because these decisions exist, not because
-- literal proposal ids were typed into `content_sessions`.
INSERT INTO review_decisions (event_id, proposal_id, outcome, decided_by, decided_at, note) VALUES
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010', 'accepted', 'seed-organizer', '2026-08-09T15:00:00.000Z', 'Strong fit for the operations track.'),
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'accepted', 'seed-organizer', '2026-08-09T15:05:00.000Z', 'The accessibility workshop the programme was missing.');

INSERT INTO review_plans (event_id, criteria_json, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '[{"id":"relevance","name":"Relevance","description":"Fit for this audience","type":"numeric","minScore":1,"maxScore":5,"weight":2},{"id":"format","name":"Recommended format","description":"Choose the best delivery format","type":"dropdown","options":["Talk","Workshop","Panel"],"weight":1},{"id":"feedback","name":"Reviewer feedback","description":"Explain the recommendation","type":"text","maxLength":1000,"weight":1}]', '2026-08-09T12:00:00.000Z');

/*
 * Two rounds that differ in every dimension the product makes configurable, because a demo with
 * one round proves nothing about rounds.
 *
 * `First pass` is blind, scores against the event plan, and its pool is both reviewers.
 * `Programme committee` is open review, carries **its own scorecard**, and its pool is Nina alone
 * — so the demo starts in the state the acceptance criteria describe: a reviewer who worked in
 * round 1 is absent from round 2 until somebody adds them. Ravi's queue is round 1's, which is
 * what keeps the seeded reviewer journey exactly as it was.
 *
 * Each carries a real `opens_at` and **no** `closes_at`, and the missing half is deliberate. The
 * product honours the wall clock, so a fixed future close date is a timebomb on a deterministic
 * fixture: past it, Ravi's seeded evaluation is refused, the browser journey that drives it fails,
 * and `gate:browser` goes red on a date rather than on a change. Window *enforcement* is proved
 * where a clock-dependent rule belongs — `review-rounds.test.ts` drives an unopened and a closed
 * window against an injected clock — and the console still edits both bounds.
 */
INSERT INTO review_rounds (event_id, sequence, name, opens_at, closes_at, state, anonymized, criteria_json, pool_mode, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 1, 'First pass', '2026-08-09T00:00:00.000Z', NULL, 'open', 1, NULL, 'named', '2026-08-09T11:00:00.000Z', '2026-08-09T11:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000001', 2, 'Programme committee', '2026-08-12T00:00:00.000Z', NULL, 'open', 0, '[{"id":"programme_fit","name":"Programme fit","description":"Balance across the final programme","type":"numeric","minScore":1,"maxScore":5,"weight":3},{"id":"delivery","name":"Delivery confidence","description":"Confidence this speaker can deliver it","type":"numeric","minScore":1,"maxScore":5,"weight":1},{"id":"committee_note","name":"Committee note","description":"One sentence for the record","type":"text","maxLength":500,"weight":1}]', 'named', '2026-08-12T09:00:00.000Z', '2026-08-12T09:00:00.000Z');

INSERT INTO review_round_members (event_id, round_sequence, reviewer_id, added_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 1, 'seed-reviewer', '2026-08-09T11:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000001', 1, 'review-nina-alvarez', '2026-08-09T11:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000001', 2, 'review-nina-alvarez', '2026-08-12T09:00:00.000Z');

INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES
  -- Ravi's own queue: unscored, so the seeded reviewer journey starts from an empty form.
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'seed-reviewer', 1, '2026-08-09T12:00:00.000Z'),
  -- Nina's finished work, which is what puts real numbers on the organizer's results table.
  ('20000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010', 'review-nina-alvarez', 1, '2026-08-09T12:10:00.000Z'),
  ('20000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010', 'review-nina-alvarez', 2, '2026-08-12T09:10:00.000Z'),
  ('20000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'review-nina-alvarez', 2, '2026-08-12T09:11:00.000Z');

INSERT INTO review_evaluations (assignment_id, reviewer_id, scores_json, notes, state, updated_at, completed_at, source) VALUES
  ('20000000-0000-4000-8000-0000000000a2', 'review-nina-alvarez', '[{"criterionId":"relevance","value":4,"score":4},{"criterionId":"format","value":"Talk"},{"criterionId":"feedback","value":"Well scoped, and the examples are concrete."}]', 'Clear argument, would attend.', 'completed', '2026-08-10T09:00:00.000Z', '2026-08-10T09:00:00.000Z', 'manual'),
  ('20000000-0000-4000-8000-0000000000a3', 'review-nina-alvarez', '[{"criterionId":"programme_fit","value":5,"score":5},{"criterionId":"delivery","value":3,"score":3},{"criterionId":"committee_note","value":"Anchors the operations track."}]', 'The strongest opener we have.', 'completed', '2026-08-12T14:00:00.000Z', '2026-08-12T14:00:00.000Z', 'manual'),
  ('20000000-0000-4000-8000-0000000000a4', 'review-nina-alvarez', '[{"criterionId":"programme_fit","value":4,"score":4},{"criterionId":"delivery","value":2,"score":2},{"criterionId":"committee_note","value":"Well-prepared, and the workshop format is the right call."}]', 'A strong second choice for the opening slot.', 'completed', '2026-08-12T14:20:00.000Z', '2026-08-12T14:20:00.000Z', 'manual');

/*
 * The aggregates those evaluations produce, written out rather than left to be recomputed —
 * a seed is a snapshot, and the product only writes `review_outcomes` when somebody presses
 * Complete. The arithmetic is `SUM(value × weight) / SUM(weight)` over the **numeric** criteria
 * of the round's own scorecard, and each line below states its own sum so a reader can check it
 * against `d1-review-repository.integration.test.ts` without running anything:
 *
 *   round 1, `Designing the calm conference`, event plan (relevance ×2 is the only numeric):
 *     (4×2) / 2 = 4.0
 *   round 2, `Designing the calm conference`, committee scorecard (fit ×3, delivery ×1):
 *     (5×3 + 3×1) / 4 = 4.5
 *   round 2, `Accessible by default`:
 *     (4×3 + 2×1) / 4 = 3.5
 *
 * Both round-2 numbers are load-bearing. Each differs from the unweighted mean of its own two
 * values — 4.0 and 3.0 — so a results table showing 4.5 and 3.5 is showing that the weights are
 * doing something rather than that an average was taken. And the two differ from each other,
 * which is what makes sorting by aggregate, in either direction, something a person can watch
 * change on the seeded demo rather than a claim in a document.
 */
INSERT INTO review_outcomes (event_id, proposal_id, round, completed_evaluation_count, average_score, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010', 1, 1, 4.0, '2026-08-10T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000010', 2, 1, 4.5, '2026-08-12T14:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 2, 1, 3.5, '2026-08-12T14:20:00.000Z');

/*
 * One assistant draft, offered and unanswered, on the abstract Ravi opens first.
 *
 * The AI affordance already existed and already worked; what it did not have was a *seeded*
 * instance, so the reviewer journey only met it if somebody thought to press the button. An
 * offered suggestion sitting above the scoring form is the discoverability the issue asks for,
 * and it is also the safest thing to seed: `offered` is the state that has changed nothing —
 * no evaluation, no outcome, no decision — which is exactly the property the feature promises,
 * and a reader can confirm it by noting that this row has no counterpart anywhere above.
 *
 * The provenance names the deterministic fixture provider, because that is what the demo runs;
 * no credential and no network are involved in reaching this state.
 */
INSERT INTO review_suggestions (id, event_id, assignment_id, reviewer_id, proposal_id, round, summary, scores_json, state, provenance_model, provenance_prompt_version, provenance_generated_at, provenance_proposal_revision, responded_by, responded_at, created_at) VALUES
  ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'seed-reviewer', '10000000-0000-4000-8000-000000000001', 1, 'A practical, well-scoped session on hallway-track design. The abstract names concrete techniques rather than describing the problem, which suggests the talk will be actionable.', '[{"criterionId":"relevance","value":4,"rationale":"Directly addresses attendee experience, which this audience asks about every year."},{"criterionId":"format","value":"Workshop","rationale":"The techniques described are ones people would want to try in the room."},{"criterionId":"feedback","value":"Strong fit. Consider asking for one worked example from a conference the speaker has run.","rationale":"The abstract promises practice, and a worked example is what would prove it."}]', 'offered', 'fixture-suggester-v1', 'review-suggestion/v1', '2026-08-09T12:30:00.000Z', 'rev-f2833987', NULL, NULL, '2026-08-09T12:30:00.000Z');
