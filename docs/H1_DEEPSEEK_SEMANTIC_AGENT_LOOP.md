# H1 DeepSeek semantic agent loop

## Outcome

The Harness planner now has two bounded planning paths:

1. Known exact URLs, identities, and supported presets use the existing deterministic fast path.
2. Unrecognized natural language, unsupported ranking language, and clarification follow-ups use the configured DeepSeek-compatible local model proxy.

The model is an interpreter, not an executor. It can select only a registered workflow and propose schema-bound slots, or return one to three clarification questions. It receives no tools and cannot call the database, providers, paid operations, or workspace writes.

## Authoritative boundary

Every semantic result is revalidated by the existing workflow catalog and `buildPlan` contract. Unknown workflows, unknown fields, invalid identities, unbounded counts, unsupported enum values, missing project bindings, malformed JSON, oversized output, timeout, and model outage fail closed before a task is confirmed or any business bridge is called.

Each accepted authoritative plan carries a bounded `planner_audit` record. It contains only the planner mode, fixed provider/model identity, planner version, prompt/schema SHA-256, clarification state, and the authoritative validation verdict. Prompt text, credentials, headers, cookies, provider payloads, and model output are never persisted in that audit record.

Execution remains:

`natural language -> deterministic/semantic interpretation -> authoritative immutable plan -> explicit approvals -> deterministic executor`

Planning and clarification never imply approval. Paid calls, online writes, and handoff creation continue to require their exact existing approval scopes.

## Ranking truthfulness

The X provider currently proves latest-order search, not hottest-order ranking. Requests such as “最热的 X 帖子” therefore produce a bounded clarification instead of silently mapping “hottest” to “latest”. The user may explicitly accept latest-order X search or choose Reddit hot/top semantics.

## Clarification recovery

Pending questions are stored as a bounded browser record tied to the exact active project. They survive refresh and a sign-out/sign-in cycle in the same browser, but are ignored for a different active project. Answers generate a fresh request identity and return through semantic planning and the complete authoritative validation path.

## Runtime configuration

- Model path: the existing local model proxy, default `http://127.0.0.1:8791/v1/chat/completions`.
- Model identity: `HARNESS_PLANNER_MODEL`, default `deepseek-chat`.
- Timeout: finite `HARNESS_PLANNER_TIMEOUT_MS`, default 20 seconds.
- Response: strict JSON, maximum 64 KiB, temperature 0, no tool definitions.

No model credential is exposed to the browser or stored in task output.

## Deliberate limits

H1 does not create arbitrary tools or let a model emit executable code. New capabilities still enter through the reviewed workflow/tool registry. Dynamic skill discovery, long-running background orchestration, memory policy, and result critic behavior belong to the subsequent H2 milestone.
