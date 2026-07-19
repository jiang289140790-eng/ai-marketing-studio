alter table public.automation_runs
  drop constraint if exists automation_runs_status_check;

alter table public.automation_runs
  add constraint automation_runs_status_check
  check (status in ('queued', 'running', 'success', 'failed'));

alter table public.assets
  drop constraint if exists assets_source_check;

alter table public.assets
  add constraint assets_source_check
  check (source in ('manual', 'upload', 'gpt', 'claude', 'qwen', 'comfyui', 'civitai', 'n8n', 'workflow-runtime'));
