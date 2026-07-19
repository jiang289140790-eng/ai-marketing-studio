# Supabase Clean Replay Result

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Validation date: 2026-07-19  
Validation mode: Plan A, local Supabase with Docker Desktop

## Environment choice

Selected: Plan A.

Reason:

- Docker Desktop was available after starting it.
- Supabase CLI was available locally.
- Supabase Cloud project variables were not configured, so Plan B could not be executed.

## Commands executed

```bash
supabase init
supabase stop --no-backup --debug
supabase start --debug
supabase db reset --local --no-seed --debug
```

## Migration replay result

| Item | Result |
| --- | --- |
| Supabase CLI | `2.109.1` |
| Database mode | Local Docker Supabase |
| Migration files | 16 |
| Replay start | `2026-07-19T19:25:14.9108842+08:00` |
| Replay end | `2026-07-19T19:27:02.1713886+08:00` |
| Duration | `107.26` seconds |
| Status | Success |
| Migration error | None |

## Schema verification after replay

| Check | Result |
| --- | ---: |
| Public tables | 31 |
| Public indexes | 152 |
| Public tables with RLS enabled | 31 |
| Public/storage policies | 118 |
| Public functions | 0 |
| Public triggers | 0 |
| Authenticated table grants | 205 |

## Migration risk checker

Command:

```bash
npm run migrations:check
```

Result:

```text
Migration files: 16
Policy creates: 200
Guarded policy creates: 200
Ordinary policy creates: 0
Dynamic policy statements: 0
Duplicate policies: 82
Unsafe duplicate policies: 0
Duplicate tables: 22
Unsafe duplicate tables: 0
Duplicate indexes: 93
Unsafe duplicate indexes: 0
Overall status: safe
```

## Notes

- The initial `supabase start` attempt failed because Docker Desktop was not running.
- After Docker Desktop was started, Supabase needed a local config, so `supabase init` was executed.
- A second startup failed once because Docker network state was inconsistent.
- `supabase stop --no-backup --debug` followed by `supabase start --debug` fixed the local stack state.
- The final clean replay passed.

## Current conclusion

Migration clean replay is verified on local Supabase.

The next production-grade step is to run the same migration chain on a temporary Supabase Cloud project before using the real production project.

