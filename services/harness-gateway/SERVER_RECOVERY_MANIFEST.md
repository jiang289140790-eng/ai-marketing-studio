# Alibaba server recovery manifest

Host: `47.251.244.196`
Rule: H1 may stop listed containers; it may not remove containers, images, volumes, or filesystem paths.

Gateway credentials are mounted from root-owned read-only files and must never be placed in Compose environment values, task payloads, Git, logs, or review artifacts.

## Preserve and keep running

- `ceb6b42bde9f` — `ai-marketing-studio-bridge` — `ai-marketing-studio-runtime:day1-loop-16864b6` — `127.0.0.1:8787`
- `c76d9f01b0be` — `trypost-sslip-caddy` — `caddy:2-alpine` — host network
- volumes `trypost_sslip_caddy_config`, `trypost_sslip_caddy_data`

## Reversible stop set

- `8eca7cb59108` — `trypost-ops` — `trypost-ops:release-20260718-queued-pipeline-v1` — volume `trypost-ops_storage`
- `28c50a17091c` — `trypost-ops-redis` — `redis:7-alpine` — volume `trypost-ops_redisdata`
- `5619a6ad7604` — `n8n` — `n8nio/n8n:latest` — bind `/opt/n8n/data`
- `3f4975d36359` — `douyin-tiktok-api` — `evil0ctal/douyin_tiktok_download_api:latest` — binds `/opt/douyin-tiktok-api/config`, `/opt/douyin-tiktok-api/data`

Stop in this order: `trypost-ops`, `trypost-ops-redis`, `n8n`, `douyin-tiktok-api`.

Restore in this order: `trypost-ops-redis`, `trypost-ops`, `n8n`, `douyin-tiktok-api`. After restore, require the two TryPost containers to become healthy and confirm the two public ports are listening.

## Stopped rollback containers to preserve

`a7eb2402e476`, `8eba80a23b0f`, `afa703662ebb`, `a486bb1e9a0e`, `fbc507e90ee1`, `2fa7a311c754`, `0fb118888e9c`.

## Additional volumes to preserve

`trypost-ops_pgdata` and `3fa7a47374fd498a61efaf343e27a73d9bb026cc0552c01981b3e61750d719b9`.

No `docker system prune`, wildcard removal, image removal, volume removal, or recursive filesystem deletion is permitted before H5 rollback proof.
