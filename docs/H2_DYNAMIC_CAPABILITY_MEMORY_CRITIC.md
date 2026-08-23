# H2 Dynamic Capability, Project Memory and Execution Critic

H2 extends the H1 semantic planner without turning the model into a free-form tool executor.

- The capability manifest is generated at runtime from the reviewed workflow registry. Its version and SHA-256 fingerprint bind every new task.
- Project task memory contains only bounded same-user/same-project workflow outcomes and safe artifact identities. It never stores approvals, prompts, raw model output, tool payloads, credentials or cross-project data.
- The preflight critic checks the authoritative plan against the current capability manifest and project-memory binding before a task can be confirmed.
- The postflight critic checks dependency order, step terminal states and the outer outcome. It may recommend one exact retry-safe failed step, but never retries by itself.
- Paid or ambiguous outcomes, dependency failures and registry drift remain fail-closed and require a new explicit plan.

This local milestone does not connect to a model, Supabase, a provider or production and does not authorize deployment.
