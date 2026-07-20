# Phase 3.2 Analysis Agent Report

## 1. Goal

Phase 3.2 implements the first real AI Agent calling loop for AI Marketing Studio.

Implemented scope:

```text
viral_contents
↓
Analysis Agent
↓
AI Gateway
↓
OpenAI / Anthropic Claude / DeepSeek
↓
content_analysis
↓
agent_runs + tool_usage + cost_records
```

This phase intentionally does not implement:

- Content Generation Agent real AI calls;
- Asset Generation Agent real AI calls;
- Qwen;
- ComfyUI;
- RunningHub;
- automated social publishing changes;
- SaaS billing or subscription features.

## 2. Files Added

### Frontend AI Gateway client

- `src/services/ai-gateway-service.js`

Purpose:

- exposes `generateAI()`;
- calls Supabase Edge Function `ai-gateway`;
- does not call OpenAI or Anthropic directly;
- does not read API keys.

### Supabase Edge Function

- `supabase/functions/ai-gateway/index.ts`

Purpose:

- verifies Supabase user session;
- reads AI provider keys only from Supabase Edge Function Secrets;
- supports OpenAI, Anthropic Claude, and DeepSeek;
- normalizes output into:
  - `content`
  - `usage`
  - `cost`
  - `duration`
  - `status`
- records usage and cost into Supabase.

### Migration

- `supabase/migrations/20260720060033_phase3_2_analysis_agent_ai_gateway.sql`

Added columns to `content_analysis`:

- `analysis_result jsonb`
- `recommendation text`
- `provider text`
- `model text`
- `usage jsonb`
- `cost numeric(12, 6)`

Added indexes:

- `content_analysis_provider_idx`
- `content_analysis_model_idx`

## 3. Files Updated

### `.env.example`

Added AI Gateway related Edge Function secret placeholders:

- `AI_GATEWAY_DEFAULT_MODEL`
- `OPENAI_INPUT_COST_PER_1K`
- `OPENAI_OUTPUT_COST_PER_1K`
- `ANTHROPIC_INPUT_COST_PER_1K`
- `ANTHROPIC_OUTPUT_COST_PER_1K`

Existing provider secrets remain:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

These are Edge Function secrets only. They must not be exposed in GitHub Pages frontend builds.

### `src/services/intelligence-service.js`

Added:

- `analyzeViralContentWithAI()`
- automatic Analysis Agent lookup/creation;
- Agent task creation;
- Agent run creation;
- AI Gateway call;
- AI response parsing;
- `content_analysis` save;
- `viral_contents` update with `viral_reason` and `ai_recommendation`;
- Agent run success/failure update;
- Agent task success/failure update.

The old local `analyzeViralContent()` remains available and was not deleted.

### `src/pages/ContentIntelligence.jsx`

Updated the content opportunity action button:

- old behavior: local rule-based `生成分析`;
- new behavior: real `AI分析` through Analysis Agent and AI Gateway;
- added per-item loading state: `AI分析中...`.

## 4. AI Gateway MVP Interface

### Input

```json
{
  "action": "generate",
  "agent_name": "Analysis Agent",
  "prompt": "Analyze this viral content and return JSON...",
  "model": "gpt-4.1-mini",
  "provider": "openai",
  "parameters": {
    "temperature": 0.35,
    "max_output_tokens": 1200
  },
  "agent_run_id": "agent run uuid",
  "usage_type": "analysis"
}
```

### Output

```json
{
  "status": "success",
  "agent_name": "Analysis Agent",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "content": "{...}",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  },
  "cost": {
    "currency": "USD",
    "amount": 0,
    "estimated": true
  },
  "duration": 1200
}
```

## 5. Provider Support

### OpenAI

Implemented through Edge Function only.

Provider call:

- `POST /v1/responses`

Source reference:

- OpenAI official Responses API documentation says the Responses API is the recommended API for direct model requests and supports text/JSON outputs.

### Anthropic Claude

Implemented through Edge Function only.

Provider call:

- `POST /v1/messages`

Source reference:

- Anthropic official Messages API documentation describes sending a structured message list and receiving model-generated content.

### Not implemented yet

- Qwen

Qwen remains planned for a later phase.

### DeepSeek

Implemented through Edge Function only.

Provider call:

- `POST /chat/completions`

Default supported model examples:

- `deepseek-chat`
- `deepseek-reasoner`

## 6. Secret Management

Required Supabase Edge Function secrets:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
DEEPSEEK_API_KEY
```

Optional:

```text
AI_GATEWAY_DEFAULT_MODEL
OPENAI_BASE_URL
ANTHROPIC_BASE_URL
ANTHROPIC_VERSION
DEEPSEEK_BASE_URL
OPENAI_INPUT_COST_PER_1K
OPENAI_OUTPUT_COST_PER_1K
ANTHROPIC_INPUT_COST_PER_1K
ANTHROPIC_OUTPUT_COST_PER_1K
DEEPSEEK_INPUT_COST_PER_1K
DEEPSEEK_OUTPUT_COST_PER_1K
```

Frontend allowed:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

Forbidden in frontend:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- any model provider secret.

## 7. Data Written by One AI Analysis

When clicking `AI分析` on a viral content item, the system writes/updates:

### `agents`

If no Analysis Agent exists, creates:

- `name = Analysis Agent`
- `type = analysis`
- `model = gpt-4.1-mini`

### `agent_tasks`

Creates a task:

- `task_type = analysis`
- `status = running -> success/failed`
- `input_data.viral_content_id`
- `result.content_analysis_id`

### `agent_runs`

Creates a run:

- `agent_name`
- `input.prompt`
- `output`
- `status`
- `cost`
- `duration`
- `error_message`

### `content_analysis`

Creates analysis:

- `analysis`
- `analysis_result`
- `viral_reason`
- `recommendation`
- `ai_recommendation`
- `hook`
- `structure`
- `strategy`
- `replication_notes`
- `fit_score`
- `provider`
- `model`
- `usage`
- `cost`

### `viral_contents`

Updates:

- `viral_reason`
- `ai_recommendation`

### `tool_usage`

Edge Function records:

- `tool_name = ai-gateway`
- `provider`
- `usage_type = analysis`
- `units = total tokens`
- `total_cost`
- `related_agent_run_id`

### `cost_records`

Edge Function records:

- `category = ai`
- `source = provider:model`
- `amount`
- usage metadata.

## 8. Cost Handling

Cost calculation is supported but conservative.

If rate secrets are not configured, cost is recorded as `0` with:

```json
{
  "estimated": true,
  "rate_source": "not_configured"
}
```

If rate secrets are configured, AI Gateway estimates cost from:

- input tokens;
- output tokens;
- provider/model rate variables.

## 9. Validation Result

Executed:

```text
npm run lint
npm run migrations:check
npm run build
```

Result:

- lint: passed
- migrations check: passed
- build: passed

Build artifact:

- `dist/assets/index-D4nWEdMu.js`
- `dist/assets/index-Dz3Ecm51.css`

## 10. Deployment Notes

Before real production use:

1. Deploy migration to Supabase:

```text
supabase db push
```

2. Deploy Edge Function:

```text
supabase functions deploy ai-gateway --project-ref <project-ref>
```

3. Set Edge Function secrets:

```text
supabase secrets set OPENAI_API_KEY=...
supabase secrets set ANTHROPIC_API_KEY=...
supabase secrets set DEEPSEEK_API_KEY=...
supabase secrets set AI_GATEWAY_DEFAULT_MODEL=gpt-4.1-mini
```

4. Optional cost rates:

```text
supabase secrets set OPENAI_INPUT_COST_PER_1K=...
supabase secrets set OPENAI_OUTPUT_COST_PER_1K=...
supabase secrets set ANTHROPIC_INPUT_COST_PER_1K=...
supabase secrets set ANTHROPIC_OUTPUT_COST_PER_1K=...
```

## 11. Current Limitations

- AI Gateway is implemented but not deployed by this local code change.
- Real provider calls require Supabase secrets to be configured.
- Qwen and DeepSeek are not implemented in Phase 3.2.
- Analysis prompt is JSON-oriented but provider output may still be malformed; parser falls back to raw text.
- Exact provider pricing is not hardcoded to avoid stale costs.

## 12. Next Recommended Phase

Phase 3.3 should be:

1. Deploy `ai-gateway`.
2. Configure OpenAI or Anthropic secret.
3. Run one real `AI分析` from Content Intelligence.
4. Verify:
   - `content_analysis`
   - `agent_runs`
   - `tool_usage`
   - `cost_records`
5. Only after that, connect Content Generation Agent.
