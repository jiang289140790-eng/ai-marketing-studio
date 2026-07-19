# AI Marketing Studio Database

## Product positioning

AI Marketing Studio is a personal AI content operations system, not a commercial SaaS billing product.

The database keeps cost, tool usage, analytics, metrics, and ROI-style fields for personal operations review. These records are not subscription billing, payment plans, or member packages.

Current core direction:

- Account matrix management
- Automated content production
- Multi-platform publishing
- Performance feedback
- AI operations agents

Future-reserved only:

- `plans`
- `subscriptions`
- Stripe / billing

Supabase migration files live in:

- `supabase/migrations/202607190001_initial_schema.sql`
- `supabase/migrations/202607190002_workspace_taxonomy_upgrade.sql`
- `supabase/migrations/202607190003_content_asset_system.sql`
- `supabase/migrations/202607190004_workflow_runtime_center.sql`

## Tables

- `profiles`
- `social_accounts`
- `content_library`
- `assets`
- `characters`
- `prompts`
- `workflow_runs`
- `agents`
- `agent_tasks`
- `competitor_accounts`
- `viral_contents`
- `content_analysis`
- `content_sources`
- `collection_tasks`
- `collection_runs`
- `automation_jobs`
- `automation_runs`
- `platform_connections`
- `platform_credentials`
- `publish_tasks`
- `viral_analysis`

## Workflow production loop

`workflow_runs` records the AI content production process:

```text
character → prompt → assets → workflow → output → asset → content_library
```

Fields:

- `workflow_id` references a Workflow asset.
- `tool_id` identifies the runtime source, such as `manual-runtime`, `runninghub`, `comfyui`, or `n8n`.
- `character_id` references `characters`.
- `prompt_id` references `prompts`.
- `asset_ids` stores input asset IDs.
- `input_data` stores runtime parameters.
- `output_data` stores final output metadata and linked `asset_id` / `content_id`.
- `status` supports `pending`, `running`, `success`, `failed`.
- `cost` stores estimated or actual runtime cost.

## Agent automation loop

`agents` defines reusable AI workers:

- `content_generator`: creates content drafts.
- `asset_generator`: creates `workflow_runs`.
- `analysis`: reads content data and creates optimization suggestions.

`agent_tasks` records every execution:

- `agent_id` references `agents`.
- `task_type` supports `content_generation`, `asset_generation`, `analysis`.
- `workflow_id` optionally references a Workflow asset.
- `input_data` stores the task brief and selected context.
- `result` stores linked output such as `content_id`, `workflow_run_id`, or analysis suggestions.
- `status` supports `pending`, `running`, `success`, `failed`.

## Content Intelligence loop

Content Intelligence provides external content signals for Agents:

```text
competitor_accounts → viral_contents → content_analysis → analysis agent → strategy → content production
```

- `competitor_accounts` stores competitor or inspiration accounts by platform, category, audience, follower count, and notes.
- `viral_contents` stores saved viral posts with URL, text, media, views, likes, comments, and published time.
- `content_analysis` stores AI analysis for a viral content item, including hook, structure, and replication strategy.
- Analysis Agents can read `viral_contents` and produce `content_intelligence_strategy`.

## Social Intelligence Collector loop

Collection Center prepares automatic external intelligence collection:

```text
content_sources → collection_tasks → collection_runs → future API connector → content intelligence
```

- `content_sources` stores competitor accounts, channels, keywords, hashtags, RSS feeds, or manual sources.
- `collection_tasks` stores collection frequency, status, last run, and next run.
- `collection_runs` stores execution history, status, errors, `items_found`, and `duration_ms`.
- Telegram public channels are supported through `telegram-collector.js`.
- `content_sources` can store Telegram `channel`, `username`, `last_message_id`, and `sync_time`.
- Real X / Reddit / YouTube connectors are intentionally not implemented yet.

## Automation Orchestrator loop

Automation Center unifies collector, agent, and workflow task management:

```text
automation_jobs → automation_runs → future n8n / Cron / Queue Worker runtime
```

- `automation_jobs` stores job name, type, schedule, target, config, status, last run, and next run.
- `automation_runs` stores queued/running/success/failed execution history, result payload, and errors.
- Job types: `collector`, `agent`, `workflow`.
- Job statuses: `active`, `paused`, `failed`.
- `automation-runner.js` executes the internal modules:
  - collector jobs call `collector-service.runCollection()`;
  - agent jobs call `agent-service.executeAgentTask()`;
  - workflow jobs call `workflow-service.createWorkflowRun()` and `saveWorkflowResult()`.
- Real schedulers and queue workers are intentionally not implemented yet.

## Social Platform Integration boundary

Platform Integration prepares a safe connection model for Telegram, X, Instagram, TikTok, and YouTube:

```text
platform_connections → Settings UI status
platform_credentials → Supabase Edge Function only
platform adapters → shared interface placeholders
automation platform jobs → future publish / sync_metrics actions
```

- `platform_connections` stores non-secret connection state, platform, linked `social_accounts.id`, connected time, and last sync.
- `platform_credentials` stores encrypted provider tokens and refresh tokens. It has RLS enabled but no authenticated policies and no frontend grant.
- The frontend must never read `platform_credentials`.
- `supabase/functions/platform` is the future server-side boundary for token reads, token refresh, provider collection, provider metrics, and publish calls.
- No real publish integration is implemented in this phase.

## Publish Center loop

```text
content_library -> publish_tasks -> platform adapter -> publish result
automation platform job(action=publish) -> publish task -> platform adapter
```

- `publish_tasks` stores the selected content, optional `platform_connection_id`, platform, `scheduled_time`, status, provider `external_id`, JSON `result`, `error_message`, and `published_at`.
- Publish statuses are `draft`, `scheduled`, `publishing`, `published`, and `failed`.
- `publish-service.js` manages task creation, status updates, adapter execution, and history reads through Supabase.
- The current platform adapters are placeholders, so calling publish records the status transition and adapter error, but does not send real posts.

## Content Performance Analytics loop

```text
publish_tasks -> content_metrics / publish_metrics -> analysis agent -> content_strategies
```

- `content_metrics` stores content-level views, likes, comments, shares, clicks, registrations, revenue/effect value, and collection time.
- `publish_metrics` stores metrics snapshots for a `publish_tasks.id` and the last sync time.
- `content_strategies` stores `optimization_strategy` JSON produced by Analysis Agent or Performance Center.
- Performance Center shows content performance, platform performance, account-category performance, conversion data, personal ROI, and content type ranking.
- No real platform metrics API is implemented yet; metrics are manual or future Edge Function outputs.

## Telegram feedback and conversion loop

```text
telegram webhook -> publish_tasks(external_id) -> content_metrics / publish_metrics
content_library -> campaign_links -> publish_tasks.campaign_id -> clicks / registrations / revenue
```

- `campaign_links` stores user-owned UTM links, clicks, registrations, and revenue/effect value.
- `publish_tasks.campaign_id` binds one Telegram post task to one campaign link.
- Telegram webhook updates are verified by `TELEGRAM_WEBHOOK_SECRET` before writing metrics.
- Performance Agent uses content metrics plus campaign links to produce personal operations optimization strategies.

## Production stability

- Task retry fields: `retry_count`, `max_retry`, and `last_error` are added to Collector, Agent, Workflow, Publish, and Automation task/run tables.
- `notifications` stores in-app failure notices and reserves Telegram / Email channels.
- `cost_records` stores daily AI, Workflow, and API cost plus optional revenue/effect value for personal operations review.
- `audit_logs` records changes to tools, workflows, campaigns, prompts, assets, content, and settings.
- System Health summarizes task success rate, failure rate, queue state, API status, costs, profit, notifications, and audit activity.

## Security model

- All user-owned tables use RLS.
- Authenticated users can only read/write rows where `user_id = auth.uid()`.
- `profiles.id` maps directly to `auth.users.id`.
- Supported platforms in this phase: `X`, `Instagram`, `TikTok`, `YouTube`, `Telegram`.
- Content statuses: `draft`, `review`, `scheduled`, `published`, `failed`.
- Account categories: `brand`, `personal`, `competitor`, `inspiration`.
- Asset types: `image`, `video`, `audio`, `prompt`, `workflow`, `lora`.
- `content_library` can reference `asset_id`, `character_id`, and `prompt_id`.
- Storage bucket `marketing-assets` stores files under `{user_id}/...`.
- The frontend must use only `VITE_SUPABASE_ANON_KEY` or Supabase publishable key. Never expose `service_role`.
