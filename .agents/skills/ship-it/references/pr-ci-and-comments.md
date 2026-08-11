# PR, CI, and review comments

Use this reference for GitHub publication, CI repair, the bot observation window, and final comments.

## Publication and CI

- Resolve the repository, default branch, current PR, and authentication before Git writes.
- Default to a draft PR.
- Preserve unrelated worktree changes.
- After each push, wait for required checks on that exact head SHA.
- For failures, inspect the failing job log, state the root cause, make the smallest correction, reproduce locally, and push.
- Treat cancelled, skipped, neutral, and external checks accurately; green means all required checks passed.

## Automated-review observation

Record the head SHA and the time required CI becomes green. Observe for 15 minutes from that green timestamp.

Poll all three surfaces because any one can be incomplete:

- PR reviews;
- top-level conversation comments;
- thread-aware inline review threads including resolved/outdated state.

Use waits or polls of at most 60 seconds and provide concise progress updates. When new feedback produces a push, discard the old deadline and start a new quiet window only after required CI on the new SHA is green.

Triage bot feedback on merit. Do not implement suggestions that broaden scope, contradict product intent, weaken safety, or introduce needless machinery. Record rejections with evidence.

## Findings comment

Create or update a single comment with this marker and structure:

```markdown
<!-- ship-it-findings -->
## Ship It review findings

Head: `<sha>` · Ralph: `satisfied` · Required CI: `green`

| ID | Source | Severity | Area | Finding | Disposition | Evidence |
|---|---|---|---|---|---|---|
| ... |

Review opinions checked:
- ...
```

Include fixed, rejected, duplicate, outdated, and deferred findings. Keep evidence short and link to a test, file, commit, or thread when possible.

## Remaining-work comment

Create or update a separate comment:

```markdown
<!-- ship-it-remaining -->
## Remaining work

### Must address before merge
- None.

### Deferred follow-up
- `#<issue>` — `<item>` — owner, reason, and closure condition.

### External verification
- `#<issue>` — `<item>` — current state and how to verify.
```

Never hide unresolved blockers among deferred items. If all sections are empty, retain the comment and state `None` so reviewers know the list was considered.

Every actionable deferred follow-up or external verification that will remain after merge must link to an open issue. Prefer updating an existing issue whose scope and owner fit; otherwise create a focused issue. Do not create duplicate trackers. Pending reviews, completed observation notes, and other non-actionable status statements do not require issues.

## Idempotent updates

Search existing PR comments for each HTML marker. Edit the matching comment when found; create it only when absent. Ensure the final comments describe the latest pushed SHA and the final findings ledger.
