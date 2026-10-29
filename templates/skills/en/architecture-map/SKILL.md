---
name: architecture-map
description: "Self-contained architecture map: nine tabbed views, ASCII fallback per diagram, Mermaid appendix, generated from facts.json; scales to huge monorepos and HPC clusters via an index plus domain pages."
---

# Architecture map

Produce an **architecture map someone can open and understand**: how the system is layered, how it runs, how data flows, what breaks when something breaks.

This process is written for **very large projects**. On a small one it is merely fast. On a big one, skipping it produces a page crammed with boxes, overflowing text, and nobody willing to read it.

## 1. Measure first, decide page count second

No guessing at "big". Count first (files, directories, packages, languages):

```bash
find . -path ./node_modules -prune -o -type f -print | wc -l
find . -path ./node_modules -prune -o -type d -print | wc -l
ls package.json */package.json 2>/dev/null | wc -l      # monorepo
wc -l $(git ls-files '*.go' '*.ts' '*.py' 2>/dev/null) | tail -1
```

| Tier | Trigger (any) | Output | Nodes per diagram | Pages |
|---|---|---|---|---|
| **S** | ≤300 files and one service | one `docs/architecture.html` | 30 | 1 |
| **M** | ≤3,000 files or ≤10 packages | one page, split into 2–3 if needed | 30 | 3 |
| **L** | ≤50,000 files or a multi-service monorepo | index + one page per domain | 24 | 13 |
| **XL** | >50,000 files / multi-repo / HPC cluster | index + domain pages, **generated on demand** | 16 | as needed |

Put the tier and the numbers into `facts.json` and into the first line of your report. If you picked wrong, re-pick; do not force the fit.

**XL hard rule**: the index carries only three things — (a) domain map, (b) deployment/scheduling topology, (c) one primary flow. Every other domain gets its own page; domains you did not generate are listed in the index as "not generated (why)". Do **not** put fifty services on one diagram.

## 2. Facts first: `facts.json`

No human-authored facts. Scan with a script into `docs/architecture/facts.json`; draw only from it.

```json
{
  "generatedAt": "2026-10-30T00:00:00Z",
  "root": "/abs/path",
  "tier": "L",
  "scale": { "files": 0, "dirs": 0, "loc": 0, "packages": 0, "languages": { "ts": 0 } },
  "domains": [{
    "id": "orders", "name": "Orders",
    "paths": ["services/orders"], "entry": ["services/orders/src/main.ts"],
    "process": "container", "data": ["orders_db"], "dependsOn": ["auth", "mq"]
  }],
  "entrypoints": [{ "path": "cmd/api/main.go", "kind": "http|cli|worker|job" }],
  "deploy": [{ "file": "docker-compose.yml", "kind": "compose" }],
  "scheduler": [{ "file": "slurm.conf", "kind": "slurm" }],
  "external": [{ "name": "Postgres", "refs": ["deploy/compose.yml:12"] }],
  "claims": [{ "id": "c1", "text": "Orders persist asynchronously via the outbox", "refs": ["services/orders/src/outbox.ts:44"] }]
}
```

Rules:

- **Every claim has at least one `refs`**, `path:line`, and the file must exist. If you cannot produce one, write `"status":"unconfirmed","missing":"no migrations directory"`. Never fill gaps with what is normally true.
- Split domains by **deployment unit / process boundary / data ownership**, not by directory order. One domain, one data store; cross-domain traffic goes through an API or a message.
- Generated code, `vendor/`, `third_party/`: list them in `scale` with the exclusion reason.

## 3. Generate, do not hand-draw

The HTML **must be rendered by a script from `facts.json`**: `docs/architecture/build.mjs` (or `build.py`), standard library only, runs offline.

- The layout function handles: no overlaps, wrapping by character count, auto node height, culling to the tier's node budget. Hand-written SVG past 30 nodes always overlaps — do not.
- SVG and ASCII are rendered **from the same data**. Never write them twice.
- Every node carries `data-ref="path"` so the checker can verify it.
- Exactly one hand-drawn diagram is allowed: the S-tier overview. Everything else is generated.

## 4. Nine views (all present, or state why)

Keep the tab and write the reason; do not delete it — an empty tab is information.

| # | View | What it shows | How to keep it small |
|---|---|---|---|
| 1 | Layered tech tree | ingress / application / domain / data, real components + directory | domain-level components only |
| 2 | Code directory tree | two levels + purpose of each directory | from level three, file counts only |
| 3 | Runtime process tree | what runs, who starts whom | aggregate by role, not by instance |
| 4 | End-to-end data flow | one full request, protocol and timeout per hop | **one** representative flow; the rest as a table |
| 5 | Event intake and fan-out | external event → condition → handler | event kinds only, not every handler |
| 6 | Link sequence | the most important business path | one path; group failure branches into three |
| 7 | State machine | the entity with real transitions | one entity; the rest as a state table |
| 8 | Deployment topology | hosts / containers / ports / domains / certs / DB | group by environment or role |
| 9 | Failure degradation | who breaks whom, fallback or not | only edges with a fallback or an explicit "none" |

**If a scheduler is detected (SLURM / PBS / LSF / K8s Job / AWS Batch / MPI), add a tenth view, "Jobs and scheduling"**: login/submit node → queue → compute pool → parallel filesystem → where results land; mark quotas, walltime, checkpoint location. If none is detected, say "no scheduler configuration found (checked `slurm.conf`, `*.sbatch`, `#SBATCH`, `k8s/`, scheduler traces in `Dockerfile`)".

## 5. Elision: if it does not fit, say so

- ≤3 of a kind: list all. More than 3: list the first 3 plus `+N more`, and keep the full set in `facts.json`.
- When a diagram exceeds the tier budget, **merge siblings first**; crop only after merging, and put what you cropped on a "not expanded" page.
- Elision must be visible in two places: `+N` in the SVG/HTML *and* `+N` in the ASCII. **Silent dropping is fabrication.**

## 6. HTML completeness checklist (per page)

- [ ] `<!doctype html>`, `<meta charset="utf-8">`, `<meta name="viewport">`, `<title>`
- [ ] Non-index pages link "← back to index", and the target exists
- [ ] In-page TOC + tabs (pure CSS `:target` or radio, **no JS dependency**)
- [ ] Every diagram has an "ASCII" fold beneath it
- [ ] A "sources" table: one row per claim with `path:line`
- [ ] Footer: generated at, tier + its numbers, facts fingerprint, number of elided items
- [ ] Page ≤1.5 MB; page count ≤tier limit; pages not generated are listed by name with the reason
- [ ] Opens offline: no CDN, no web fonts, no remote images, no `url(...)`, no `@import`
- [ ] Dark background, one accent, 1px hairlines; SVG scales to 100% (`viewBox` computed from content — never hard-code 900)

## 7. ASCII rules

- Monospace, ≤100 characters per line, ≤60 lines per block.
- Use `│ ├ └ ↓ →` for structure; never build boxes out of CJK characters (they take two columns and never align).
- ASCII and the diagram say the same thing; every `+N` elision appears in both.

## 8. Mermaid appendix

`docs/architecture/architecture.mmd`, one `%% === N view ===` section per view:

- `sequenceDiagram` for flows, `flowchart LR` for structure, `stateDiagram-v2` for states, `flowchart TB` + subgraph for deployment and scheduling.
- English node ids; display text in any language.
- Same diagram as the HTML; change one, change both.

## 9. Self-check: a script, not your eyes

`docs/architecture/check.mjs`, non-zero exit on failure:

1. every `href` / `data-ref` points at an existing local path;
2. no `http://`, `https://`, `src=`, `@import`, `url(` anywhere;
3. every `<pre>` ≤100 chars/line and ≤60 lines; every diagram ≤ the tier's node budget; every tab holds a diagram or a stated reason — an empty tab fails;
4. every page ≤1.5 MB; page count ≤tier limit;
5. every `facts.json` claim has ≥1 ref and the ref exists;
6. print a table: page / diagrams / nodes / bytes / elided.

## 10. Anti-patterns (any one means redo)

- dumping the whole directory tree into the HTML
- one box per file
- two questions on one diagram
- hand-drawing an SVG past 30 nodes
- filling facts with "usually" or "generally"
- writing "none" where you mean "not found" (say "unconfirmed" and what is missing)
- one page for a big project followed by "too much content, so it was omitted"

## 11. Wrap-up

Report:

1. **Tier and its numbers**;
2. **Page list**: one line each; anything not generated by name and reason;
3. **One line per view** (plus jobs and scheduling if detected);
4. **What was elided**: N places, pointing at the `facts.json` section;
5. **Unconfirmed items** and the evidence that is missing;
6. **The checker's output table**.

Never render "not done" as "does not exist". Never summarise a view in one line — that line is for the report, not for the map.
