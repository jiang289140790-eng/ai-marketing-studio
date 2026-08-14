# Harness integration architecture

Status: H0 foundation contract
Product baseline: `e66245d98b336eae192dc5ecc33330bb751bc136`
Harness reference: `@deepseek-ai/dsh@0.1.0-rc.6`, upstream commit `47f943859bef60e4160492346772ded9b24f765a`

## Product outcome

The public site becomes a natural-language operating surface instead of a collection of long forms. A signed-in operator can describe a goal, inspect the proposed plan, approve bounded side effects, follow progress, and open the resulting Evidence, Analysis, Knowledge Card, Brief, or Handoff artifact.

The existing P19/P22 contracts remain the source of truth. Harness orchestrates them; it does not replace their validation, lineage, idempotency, revision guards, RLS, or human-review gates.

## Runtime topology

```text
GitHub Pages (React)
  -> Supabase Auth (existing GitHub login)
  -> Supabase Edge command gateway (JWT, role, request envelope, audit)
  -> Alibaba Cloud HTTPS Harness Gateway (private service token from Edge only)
  -> DeepSeek Harness, single worker
  -> allowlisted AMS plugins
       - research.collect/search/analyze (P22)
       - workspace project/evidence/analysis/card/brief/handoff (P19)
       - task status and artifact reads
  -> Supabase staging contracts
```

The browser never receives a database administrator credential, Harness credential, or service-role credential. The Alibaba service never receives a production reference or production credential.

## Harness deployment profile

- Linux container on Alibaba Cloud; do not run the long-lived process on GitHub Pages or Supabase Edge.
- Pin `@deepseek-ai/dsh` to `0.1.0-rc.6`; upgrades require a compatibility review because the project is a developer preview.
- Bind Harness itself to loopback. Caddy exposes only the purpose-built AMS gateway route over HTTPS.
- Initial concurrency: one active task; queue capacity: ten; one task per authenticated AMS user at a time.
- No local model, video transcoding, browser automation, unrestricted shell, dynamic Cordis package tool, or arbitrary filesystem tool in the production profile.
- Container memory ceiling: 1536 MiB; restart on failure; durable session/audit volume; bounded log rotation.
- Every model-visible input and every plugin result must be reconstructable from the Harness session log and the AMS task ledger.

## Capability policy

### Automatically allowed

- Read the current user's projects and artifacts.
- Search or collect public research through the existing P22 boundary.
- Run the existing analysis contract after showing cost and scope.
- Create/update Evidence, versioned Analysis, Knowledge Cards, pending-review Briefs, and Handoff drafts through the existing command contracts.
- Retry idempotent infrastructure failures within a bounded retry policy.

### Human approval required

- Any paid external call after the displayed estimate.
- Saving a generated artifact that changes the current online project.
- Approving/returning a Brief.
- Creating a generation handoff.
- Adding or upgrading a Harness plugin.

### Permanently denied in this goal

- DELETE, TRUNCATE, DROP, ALTER, GRANT, migration repair, schema/RLS/Auth changes.
- Service-role exposure to the browser or direct arbitrary SQL from Harness.
- Production Supabase access (`qtrlymiqohbjvklwegsw`).
- Automatic publishing to social platforms.
- Unbounded shell, arbitrary URL fetches, secret reads, and dynamic runtime package definition.

## AMS plugin contract

Every plugin call uses a versioned envelope:

```json
{
  "schema_version": "ams_harness_tool_v1",
  "task_id": "ht-...",
  "user_id": "derived-from-verified-jwt",
  "project_id": "p19-...",
  "idempotency_key": "...",
  "operation": "workspace.project.read",
  "payload": {},
  "expected_revision": 1
}
```

Unknown operations and fields fail closed. Tool results are bounded JSON with `ok`, `code`, `task_id`, `operation`, `artifact_refs`, `cost`, and `diagnostics`. The gateway derives user identity from the verified request; it never trusts a model-provided user id.

## Data access model

Harness does not connect with database owner privileges. The Edge boundary remains the normal write route. If a later performance milestone proves a direct connection is necessary, use a dedicated `harness_operator` role with:

- broad SELECT only on approved AMS views;
- INSERT/UPDATE only through approved functions;
- no DELETE/TRUNCATE, DDL, role, Auth, Storage administration, or bypass-RLS;
- statement timeout, application name, per-task transaction, and complete audit correlation.

Creating that role changes schema/GRANT and therefore remains a separate explicit gate.

## Simplified website information architecture

Primary navigation:

1. `AI 工作台` — one natural-language task box, suggested tasks, active plan, approval card, progress, and final artifacts.
2. `任务与成果` — task history and Evidence/Analysis/Knowledge/Brief/Handoff results.
3. `账号与连接` — staging identity and available connectors, without secret values.
4. `设置` — limits, approvals, and advanced diagnostics.

The current research forms remain available under an `高级模式` disclosure during migration. The default path is:

```text
Describe goal -> Harness plan -> bounded approval -> live progress -> result cards
```

No page should show internal fingerprints, lineage JSON, execution flags, or provider diagnostics by default. They remain available in an expandable audit panel.

## Milestones and gates

### H0 — Foundation and recovery baseline

- Freeze exact versions and architecture.
- Preserve M1/M2/M3 accepted commits and review M4 as a patch source.
- Inventory Alibaba services and produce an exact reversible cleanup manifest.
- Exit: clean Harness worktree, architecture contract, server capacity plan, no remote mutation.

### H1 — Alibaba Harness Gateway

- Deploy pinned Harness and a minimal authenticated gateway.
- Single concurrency, health/readiness, queue, audit, cancellation, restart, and resource limits.
- Stop only the exact legacy containers needed for memory; preserve volumes/images until H5.
- Exit: local and server smoke tests with no AMS write capability.

### H2 — AMS plugins

- Add allowlisted tools for P19/P22 reads and writes.
- Preserve identity, revision, fingerprint, idempotency, cost, provenance, and project isolation.
- Exit: deterministic contract tests and independent review.

### H3 — Natural-language UI

- Integrate the reviewed M4 simplification and add AI Workspace/task/result surfaces.
- Keep advanced mode for existing functionality.
- Exit: desktop/mobile/browser recovery and accessibility tests.

### H4 — Staging closed loop

- Natural language request -> Evidence -> Analysis -> Knowledge -> pending Brief.
- Explicit approvals for cost and writes; no auto-publish or generation handoff approval.
- Exit: real signed-in staging E2E and zero cross-project leakage.

### H5 — Recovery, capacity, and release

- Failure injection, restart/resume, rollback, bounded logs, resource observation, independent review.
- Selective GitHub Pages release after all earlier gates pass.
- Remove preserved legacy containers/images only after rollback proof and an exact deletion manifest.

## Alibaba capacity and cleanup decision

Observed host: 2 vCPU, 3.4 GiB RAM, 4 GiB swap, 79 GiB disk. Available RAM was about 568 MiB, so adding Harness without reclaiming memory is unsafe.

Preserve initially:

- `ai-marketing-studio-bridge` and current Caddy configuration;
- all named volumes and rollback images;
- current audit/config files.

Candidate services to stop before H1 (not delete):

- `trypost-ops` and `trypost-ops-redis`;
- `n8n`;
- `douyin-tiktok-api`.

Old stopped bridge containers and obsolete unreferenced images may be deleted only after recording container/image ids, tags, sizes, volume bindings, and a tested recovery path. No broad prune or recursive filesystem deletion is permitted.

## Acceptance summary

- A browser request cannot call Harness directly.
- A model cannot invent a tool, user, project, revision, or database query.
- A failed task is resumable or safely terminal and never silently marked successful.
- Every saved artifact can be traced to the user request, plan, approval, tool calls, source evidence, model identity, cost, and final P19/P22 record.
- The default UI is task-oriented and materially simpler than the current long research page.
