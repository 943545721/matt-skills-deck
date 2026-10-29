---
name: legacy-issue-intake
description: "Convert messy legacy requirement Markdown into reviewable tickets: read-only inventory, dedupe/merge, classification, dry-run manifest, then deck-tool creation after approval; never destructive."
---

# Legacy issue intake

Turn scattered, duplicated and inconsistently formatted requirement Markdown into tickets the board can track. The process must be **auditable, reversible and interruptible**.

## Three hard rules

1. **Read-only first.** Until the user explicitly approves, create no tickets, change no labels, move or delete no files.
2. **Sources stay put.** Intake copies meaning, it does not relocate files; the old directories remain untouched forever.
3. **Never guess.** If something cannot be determined, write "unconfirmed" plus the missing evidence. "Not found" is not "does not exist".

Process files (`inventory.json` / `plan.json` / `progress.json`) live in `.deck/intake/`. They are process data, not tickets; if the user prefers nothing on disk, print the manifest in the conversation instead. `.deck/` is not in `.gitignore` today — whether to add it is the user's call.

## 0. Confirm the backend and layout first (otherwise creation fails as a batch)

Use `deck_context` or the checks page to confirm the backend, then size the plan to what it supports:

| Backend / layout | Kinds accepted | Idempotency key | parentKey |
|---|---|---|---|
| GitHub / GitLab | all six | yes (≤200 chars) | passed at creation |
| local `.scratch` | all six | yes | container parent is `00`, tickets use their number |
| local `.deck` | **`issue` / `bug` only** | **no** | **no** |

On `.deck`, spec/map containers, parent-child edges and idempotency keys are all unavailable (`server/tracker/local.ts:529`). Offer the user two options:

- initialise the `.scratch` layout first, then run the full plan;
- create flat tickets only and put relationships in the body; **without an idempotency anchor, re-runs need a manual check**, otherwise tickets duplicate.

## 1. Measure first

```bash
find . -path ./node_modules -prune -o -name '*.md' -print | wc -l
find . -path ./node_modules -prune -o -name '*.md' -print0 | xargs -0 wc -c | tail -1
```

| Tier | Trigger | Approach |
|---|---|---|
| **S** | ≤50 files | read every one |
| **M** | ≤500 files | script-cluster, judge each file without echoing it whole |
| **L** | >500 files | run per-directory campaigns, ≤100 files each, one manifest per campaign |

Put the tier and the numbers into `inventory.json` and on the first line of the report.

## 2. Inventory: a script writes the facts

Write `.deck/intake/inventory.json` (process data, not a document — keep it out of `docs/`):

```json
{
  "generatedAt": "2026-10-30T00:00:00Z",
  "root": "/abs/path",
  "tier": "M",
  "candidates": [{
    "path": "docs/old/req-login.md",
    "bytes": 1234,
    "sha256": "…",
    "format": "deck|scratch|freeform",
    "guessedTitle": "Login rework",
    "statusWords": ["done"],
    "cluster": "login",
    "duplicateOf": null,
    "excluded": null,
    "evidence": ["docs/old/req-login.md:1"]
  }],
  "totals": { "candidates": 0, "alreadyTickets": 0, "excluded": 0, "clusters": 0 }
}
```

Rules:

- Scan `.md` / `.markdown` only; exclude `node_modules/`, `.git/`, `vendor/`, `dist/`, `build/`, `.claude/`, `.agents/`, `templates/skills/`, and intake's own `.deck/intake/` (otherwise a re-run treats the old plan as a candidate).
- **`docs/agents/` holds intake conventions, not tickets.** ADRs, changelogs, meeting notes and READMEs are excluded with a stated reason.
- Recognise three formats: leading `---` with `number:` → already a ticket (record only, never recreate); `<!-- DSH-` or `Status:` / `Labels:` lines → scratch format; everything else → freeform.
- Dedupe: exact duplicates by `sha256`; near-duplicates by normalised title plus 3-shingle similarity ≥0.8; `-v2` / `-old` / dated suffixes form one timeline.

## 3. Judge each file: produce `plan`

Answer seven questions per file and write them into `.deck/intake/plan.json`:

| Field | Rule |
|---|---|
| `isRequirement` | no → excluded, with the reason |
| `kind` | only `map` / `map-ticket` / `spec` / `spec-ticket` / `bug` / `issue`; when unsure use `issue` |
| `state` | explicit done/closed → `CLOSED`; explicit open → `OPEN`; **no statement → `OPEN` + `needs-triage`** |
| `labels` | only the ten `STANDARD_LABELS` or labels the repo already has; ask before adding new ones |
| `parent` | only explicit "Part of #…" / "child of"; issue numbers do not carry across backends |
| `blockedBy` | only explicit `Blocked by:` statements |
| `evidence` | at least one `path:line` per conclusion |

Anything undetermined (state, ownership, priority) goes into the manifest as `unconfirmed` with the missing evidence. Never fill gaps with common sense.

## 4. Merge

- **Exact duplicates**: keep the most complete body as canonical; fold the rest into a "Sources" section and record `mergedFrom`.
- **Version chains**: create a ticket for the newest only; older files note `Superseded by <new ticket>` — no ticket, no deletion.
- **One requirement split across files**: create a `spec` plus child tickets linked with `deck_map_link`; do not build one giant body.
- Keep merged bodies ≤ **60,000 bytes** (`BODY_LIMIT_BYTES`, `shared/tool-contract.ts:484`); beyond that, split or use a summary plus the source path.

## 5. Dry-run manifest: the only approval point

`.deck/intake/plan.md` must contain:

- totals: candidates / already tickets / to create / to merge / excluded / unconfirmed;
- one row per action: action, title, `kind`, labels, sources, confidence `high|medium|low`;
- conflicts: two files claiming the same requirement with different states or priorities, listed one by one;
- sensitive items: suspected keys / tokens / passwords / personal data — **locations only, never the values**;
- one explicit sentence: "This manifest has not created any ticket yet."

Then stop and wait for approval. If the manifest changes, get it approved again; never execute an old manifest.

## 6. Execute (after approval)

- Use deck tools only: `deck_issue_create` (`kind` required), `deck_issue_comment`, `deck_map_link`, `deck_issue_patch` (for rollback closes). Do **not** bypass with `gh issue create` — that loses the idempotency key and map edges.
- Idempotency key: `intake:<first 12 chars of the content hash>` (≤200 chars; do not concatenate long paths), **passed explicitly on every ticket**; re-running must not duplicate tickets. If omitted, the tool auto-generates an anchor inside a 5-minute window (`shared/anchor.ts:8`), so a re-run in a later window still duplicates.
- Order: create `map` / `spec` first to get their numbers → then create child tickets **with `parentKey` at creation**; `map-ticket` must also pass `label: wayfinder:<kind>` (a type label, not an entry in `labels`) → finally use `deck_map_link` for `blockedBy`. Children cannot be linked after the fact: a `map-ticket` / `spec-ticket` without `parentKey` is rejected (`shared/issue-kind.ts:203`).
- Field limits: `title` ≤256 chars (truncate, put the full text in the body); `body` ≤60,000 bytes; `labels` / `assignees` / `blockedBy` ≤50 each.
- ≤20 tickets per batch; after each batch write `.deck/intake/progress.json` (created / skipped / failed / `maybeCreated`).
- On "may have been written, refresh first" **stop**, check with `deck_issue_list`, then decide. Never retry blindly.
- One failure must not abort the batch: record it, continue, report at the end.
- End every created body with `Source: <path> (sha256 first 12 chars)`.

## 7. Verify and report

`.deck/intake/report.md`:

1. created / skipped / failed, reconciled line by line against `plan.md`;
2. spot-check three tickets: title, body, labels, parent and blocking edges;
3. unconfirmed items and the evidence still missing;
4. **rollback**: close the created numbers with `deck_issue_patch` and an "intake rollback" comment — children before containers; closing a `map` requires a comment and all children already closed; never delete; the source files were never moved;
5. optional: drop an `ARCHIVE.md` in the old directory pointing at the new numbers (user's call).

## 8. Dirty-data playbook

| Situation | Handling |
|---|---|
| empty title or `untitled.md` | use the first heading; still none → list as unconfirmed, do not create |
| many words for one state (done / fixed / 完成) | normalise to `CLOSED`; when unsure use `OPEN` + `needs-triage` |
| images and screenshots | do not upload or base64 them; write the relative path plus "original lives in the repo" |
| BOM, CRLF, full-width colons | normalise before parsing; never edit the source |
| body over 60,000 bytes | split, or summarise and link the source path |
| suspected secrets / PII | redact in the ticket; manifest records locations only; never send them to the remote |
| links with no body | keep the link and mark it "unverified" |
| unreadable file | put it in `quarantine`, do not guess its content |

## 9. Budget and rate limits

- Never paste whole documents into the conversation; drive the work from `inventory.json` summaries.
- Each remote ticket costs at least one API call; space batches out and back off on rate limits instead of retry storms.
- For tier L, approve one directory per campaign; finish it before discussing the next.

## 10. Anti-patterns (any one means stop)

- creating tickets before approval
- intaking `docs/agents/`, ADRs or meeting notes as requirements
- treating a missing status as done
- deleting or moving old files "to tidy up"
- bypassing deck tools with `gh issue create`
- re-running without idempotency keys
- copying a suspected token into a ticket
- creating hundreds of tickets in one tier-L pass with no checkpoints

## 11. Wrap-up

1. **Tier and counts**: S/M/L plus candidates / created;
2. **Manifest and approval**: `plan.md` path, who approved and when;
3. **Created tickets** grouped by `kind`;
4. **Unconfirmed items** and missing evidence;
5. **Failures and `maybeCreated`**: ticket number or source for each;
6. **Rollback steps**;
7. **Source status**: one sentence — not moved, not deleted.

Never render "not done" as "does not exist".
