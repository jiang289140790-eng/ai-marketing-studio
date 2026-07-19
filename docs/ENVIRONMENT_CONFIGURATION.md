# Environment Configuration

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Audit date: 2026-07-19

## Rule

GitHub Pages is a frontend-only host. Only public frontend variables should be bundled into the browser.

Never expose these in frontend code:

- Supabase `service_role` key
- Telegram bot token
- Telegram webhook secret
- AI provider API keys
- X / social platform client secrets
- RunningHub or ComfyUI private keys

Those values belong in Supabase Edge Function secrets or local deployment tooling.

## Frontend public runtime

| Name | Purpose | Required |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL used by the browser client. | Yes |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon / publishable key used by the browser client. | Yes |
| `VITE_APP_BASE_PATH` | App base path hint for GitHub Pages. | Optional |
| `GITHUB_PAGES_BASE` | Vite build base path, currently defaulting to `/ai-marketing-studio/`. | Optional |

## Supabase deployment

| Name | Purpose | Required |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | Target Supabase project reference for deploy/check scripts. | Yes for deployment |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI access token for deployment. | Yes for deployment |
| `GITHUB_TOKEN` | GitHub Pages / CI deployment token if deployment is automated. | Optional locally |

## Supabase Edge Function secrets

| Name | Purpose | Required |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase URL used inside Edge Functions. | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key used only server-side for secure operations. | Yes |
| `TELEGRAM_ADMIN_BOT_TOKEN` | Telegram bot token used by the platform Edge Function. | Yes for Telegram |
| `TELEGRAM_ADMIN_CHAT_ID` | Admin or channel chat ID for Telegram posting/notifications. | Yes for Telegram |
| `TELEGRAM_WEBHOOK_URL` | Public Edge Function URL for Telegram webhook registration. | Yes for webhook |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook secret token validation. | Yes for webhook |
| `TELEGRAM_TRACKING_BASE_URL` | Base URL used to build tracked Telegram links. | Optional |
| `PLATFORM_FUNCTION_URL` | Generic platform Edge Function base URL fallback. | Optional |
| `TRACKING_EVENT_SECRET` | Secret used to validate conversion/click tracking events. | Yes for tracking |

## AI provider secrets reserved for future real generation

| Name | Purpose | Required |
| --- | --- | --- |
| `OPENAI_API_KEY` | Future GPT text/analysis generation. | Optional now |
| `ANTHROPIC_API_KEY` | Future Claude text/analysis generation. | Optional now |
| `QWEN_API_KEY` | Future Qwen text/analysis generation. | Optional now |

## Social platform secrets reserved for future X integration

| Name | Purpose | Required |
| --- | --- | --- |
| `X_CLIENT_ID` | X OAuth client ID. | Optional now |
| `X_CLIENT_SECRET` | X OAuth client secret; server-side only. | Optional now |
| `X_REDIRECT_URI` | X OAuth redirect URL. | Optional now |
| `X_API_KEY` | X app API key if required by the chosen OAuth/API mode. | Optional now |
| `X_API_SECRET` | X app API secret; server-side only. | Optional now |
| `X_BEARER_TOKEN` | X bearer token for read operations if used; server-side only. | Optional now |

## Workflow runtime secrets reserved for future generation

| Name | Purpose | Required |
| --- | --- | --- |
| `COMFYUI_BASE_URL` | Future ComfyUI endpoint. | Optional now |
| `COMFYUI_API_KEY` | Future ComfyUI auth key if the endpoint requires it. | Optional now |
| `RUNNINGHUB_BASE_URL` | Future RunningHub API base URL. | Optional now |
| `RUNNINGHUB_API_KEY` | Future RunningHub API key; server-side only when used for real tasks. | Optional now |

## Current `.env.example` status

The `.env.example` file now includes the full configuration checklist. Treat it as a template only. Do not commit real values.

## Current setup check status

`npm run setup:check` checks required frontend, deployment, and Edge Function variables. Optional future providers are shown as optional because the current phase does not connect X, OpenAI, Claude, Qwen, ComfyUI, or RunningHub yet.

