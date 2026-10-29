---
name: project-survey
description: Read each project's real structure, produce module (area) and role candidates with evidence paths; re-runs report only the diff, and nothing is written to config or labels automatically.
---

A workspace can hold several projects, each shaped differently, and all of them keep changing. So "which modules does this project have" cannot come from a fixed list — it has to be read off the real tree. This skill does that reading and hands back candidates with evidence, which the human confirms before anything reaches `.paseo-deck.json`.

## What this does not do

- Does not write `.paseo-deck.json`, does not create labels, does not edit any config;
- Does not delete existing areas and does not rename labels; items that disappeared are only marked "possibly deprecated";
- Does not guess: if it cannot be read, write "unconfirmed" and say which file was missing. An invented module key is worse than a missing one.

## Step 1: find the projects

Check in this order, stop at the first that applies:

1. `projects[]` in `.paseo-deck.json` — already configured, list what is there and add anything missing as a candidate;
2. direct subdirectories containing `.git` — the usual container workspace;
3. `pnpm-workspace.yaml` / `package.json` `workspaces` / `composer.json` `path` — a monorepo with several packages;
4. none of the above: a single project, the root is the project.

## Step 2: read each project's structure

For every project, read these (only when they exist; note what was missing):

| What | File | Why |
|---|---|---|
| Deps and scripts | `package.json` (`dependencies`, `scripts`, `workspaces`) | front end or server, runnable entries, package references |
| Backend build | `pom.xml`, `build.gradle*`, `go.mod`, `composer.json`, `pyproject.toml`, `Cargo.toml` | language, service boundary, module root |
| Monorepo | `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json` | which packages exist and where |
| Tree | two levels of `ls` (skip `node_modules`, `dist`, `build`) | top-level responsibilities |
| Deploy | `Dockerfile`, `docker-compose*.yml`, `nginx*.conf`, `deploy/`, `k8s/`, `pm2*.json` | deployable units |
| CI | `.github/workflows/*.yml`, `.gitlab-ci.yml` | what actually runs (more trustworthy than the README) |
| Mini program | `app.json`, `project.config.json`, `pages/` | WeChat client |

## Step 3: produce candidates

**Area**: one independently nameable feature or package. Typical sources are packages referenced from the workspace, backend module directories, top-level route directories in the front end. Keys are lowercase alphanumerics and hyphens, short, stable, and not tied to the current file layout. Three to eight per project is normal; more than ten usually means file names were mistaken for modules.

**Role**: the layer the whole project belongs to. Exactly one of five, or leave it empty and report "unconfirmed":

| Role | Evidence |
|---|---|
| `backend` | server framework dependency, `src/main` or routers, listens on a port |
| `frontend` | build tool plus page entry (`index.html` / router / component tree), ships static assets |
| `miniapp` | `app.json` / `project.config.json`, or a WeChat SDK dependency |
| `license` | licensing, billing, redeem codes, order reconciliation as its own service or module |
| `ops` | deploy scripts, images, CI templates, tooling not referenced by product code |

## Report format (for humans)

```
Project <key> (<dir>)
  Role: <role> (evidence: <path>)
  Area candidates:
  - api           backend API layer   evidence: src/api/index.ts:12, src/controller/
  - admin-web     admin UI            evidence: apps/admin-web/vite.config.ts:1
  - unconfirmed   -                   missing: pnpm-workspace.yaml not found
```

Every candidate must point at a real file (`path:line` preferred, a directory is fine). Candidates without evidence do not go into the list; they go under "unconfirmed".

## Step 4: diff against the last run

The previous result lives in `.deck/survey/<project>.json` (absent means first run). On a re-run, compare per project key:

- new candidates → "new";
- present last time, unreadable now → "possibly deprecated", never deleted;
- key changed but evidence path is close → "possible rename", list both;
- everything else: do not repeat.

Then overwrite `.deck/survey/<project>.json` with this run and include that path in the report.

## Step 5: hand over the confirmation list

Do not act on your own. Say exactly this:

> Once you confirm the list above, I will write `areas` and `owner` into the matching projects in `.paseo-deck.json`; tell me which ones to change.

Only write config after the user confirms. If the user says "leave it for now", keep the report and stop.
