# Harness Conversation Contract v1

Status: staging-only. Production is explicitly out of scope.

## Authority and identity

Supabase is authoritative for threads, versioned message envelopes, thread/task links, and replayable event cursors. DeepSeek Harness remains authoritative for its native session log. Existing Harness task planning, confirmation, retry, cancellation, deterministic execution, and paid-operation idempotency remain unchanged.

This release uses the product's existing personal staging tenancy model. The only accepted workspace is `ai-marketing-studio-staging`; Edge validation and the database creation RPC both reject any other workspace. No unverified multi-tenant membership model is invented by this milestone.

The stable identity chain is:

`user_id + workspace_id → thread_id → message_id/request_id → task_id? → event cursor`

Client storage contains only the selected `thread_id`; a refresh restores thread metadata and messages from the server. It never stores an authoritative message or task state.

## Authenticated Edge routes

The current Edge transport uses the existing `harness-command` function:

- `thread_create` — idempotent thread creation by `(user, workspace, request_id)`.
- `thread_get` — owner-only thread/current-task recovery.
- `thread_send` — append user message, return `202`, and start one idempotent background decision.
- `thread_messages` — stable sequence pagination.
- `GET /harness-command/threads/:threadId/events?cursor=` — SSE replay with `id`, heartbeat, and cursor reconnect.
- `thread_stop` — stop only the active assistant turn.

Task intent is sent first to the existing deterministic planner. A recognized request creates and projects the existing immutable task plan and waits for confirmation. It does not call the model or a provider. An ordinary question enters the tool-free native DSH session. Exact “执行/确认执行/开始执行” confirms the current plan through the existing task confirmation endpoint.

## Persisted message envelope

Every message carries `id`, `thread_id`, nullable `task_id`, `workspace_id`, nullable `project_id`, monotonic `sequence`, `role`, `kind`, `status`, `content`, `structured_payload`, `request_id`, nullable `parent_message_id`, timestamps, bounded errors, and `schema_version = 1`.

Every event has a stable global cursor and a per-thread request idempotency key. Replaying an accepted message or projected task snapshot returns the stored row and does not invoke the model, task runner, or provider again.

Before any model turn, the Edge atomically claims a database generation lease. Another request cannot acquire the thread while that lease is active, including from another Edge instance. Completion, failure, and user stop release only the matching generation id. Ordinary Q&A explicitly clears any historical current task instead of inheriting its task id.

Task execution projection is server-driven rather than browser-driven. Every authoritative Gateway task transition is first appended to the durable Gateway event log, then queued to an HMAC-authenticated Edge callback. Failed callbacks remain pending and retry; a separate append-only acknowledgement file prevents duplicate projection after Gateway restart. The Edge callback invokes the idempotent database projector, which resolves the user-owned thread by its current task id and writes plan, approval, tool, progress, terminal, and typed result envelopes. SSE only reads persisted events.

On Gateway restart, every complete durable task event is loaded again and filtered through the acknowledgement journal, so failed-but-unacknowledged callbacks are replayed rather than reduced to only the latest snapshot. Task results carry authoritative `{type,id}` entity relations emitted by the validated tool boundary; the database projector selects the matching owner/project table from that type and never classifies an artifact by its id prefix.

Ordinary Q&A requests have a separate append-only Gateway request/frame journal. A completed request replays its persisted native frames without spawning the model again. A request interrupted in the ambiguous window fails closed as `GENERATION_RECOVERY_REQUIRED`; it is never silently re-executed, preventing duplicate model cost. The user can then submit an explicit new request after seeing the persisted failure.

## Security

- All new tables are in `ams_private`, with forced RLS and owner policies.
- Boundary RPCs are service-role-only; the attachment ownership predicate exposes only a boolean to authenticated users.
- Attachments use the private `harness-thread-attachments` bucket and the path `<user>/<thread>/<request>/<name>`.
- Gateway requests remain HMAC-, user-, body-, timestamp-, and delegated-auth-digest-bound.
- The Q&A child sets `AMS_CONVERSATION_MODE=qa`; the AMS tool and its task operator prompt are absent. Task tools remain available only through the existing confirmed deterministic task chain.
- Authorization headers, provider keys, service-role credentials, and secrets are not stored in messages or events.

## Recovery behavior

SSE uses stable database cursors. Reconnect resumes after the last received cursor and only performs read-side task synchronization. Task snapshot projection is idempotent by task `updated_at`; it cannot repeat execution or paid calls. Authoritative plan approvals and task step states are projected as approval, tool-call, and tool-result records. Assistant stop sends the native DSH `agent.cancel({kind:'user'})`; task cancellation remains the separate existing endpoint. Native aborted/stopped completion maps to `generation_stopped`, while a failed Gateway completion maps to `error` and a failed thread state.
