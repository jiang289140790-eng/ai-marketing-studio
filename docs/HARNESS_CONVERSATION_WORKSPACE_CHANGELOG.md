# Harness conversation workspace changelog

## 2026-08-23 — staging conversation recovery

- Fixed the native Harness conversation runner so model selection setup does not return an invalid transaction value.
- Advanced the persisted Harness profile marker to refresh the corrected runner on staging.
- Added a bounded forced-termination fallback for assistant stop requests; task cancellation remains independent.
- Projected only `text-delta` chunks into assistant chat messages. Harness reasoning and tool argument deltas remain private.
- Made `/tasks/new` derive generation controls from server actions, recover ordered/deduplicated history, and reconnect from the durable event cursor.
- Added a compact empty workspace with five composer shortcuts and removed the forced blank transcript height.
- Deployed only to staging project `xtkkdvghiohlnpfnnhmx` and the authorized staging ECS instance. Production was not accessed.

Validation: frontend lint/typecheck/build, 813/813 repository tests, 213/213 Gateway tests, and real staging browser ordinary-question streaming passed.
