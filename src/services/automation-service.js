import { runAutomationJob } from './automation-runner';
import { canRetry, createNotification, nextRetryCount } from './stability-service';
import { requireSupabase } from './supabase-client';

const runSelect = '*, automation_jobs(name,type,status)';

export async function listJobs(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('automation_jobs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.type) query = query.eq('type', filters.type);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.search) query = query.ilike('name', `%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createJob(userId, payload) {
  const client = requireSupabase();
  const schedule = parseJsonField(payload.schedule, {});
  const target = parseJsonField(payload.target, {});
  const config = parseJsonField(payload.config, {});

  const { data, error } = await client
    .from('automation_jobs')
    .insert({
      user_id: userId,
      name: payload.name,
      type: payload.type,
      schedule,
      target,
      config,
      status: payload.status || 'active',
      next_run: payload.next_run || calculateNextRun(schedule),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateJob(id, payload) {
  const client = requireSupabase();
  const update = { ...payload };

  if (typeof update.schedule === 'string') update.schedule = parseJsonField(update.schedule, {});
  if (typeof update.target === 'string') update.target = parseJsonField(update.target, {});
  if (typeof update.config === 'string') update.config = parseJsonField(update.config, {});

  const { data, error } = await client.from('automation_jobs').update(update).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteJob(id) {
  const client = requireSupabase();
  const { error } = await client.from('automation_jobs').delete().eq('id', id);
  if (error) throw error;
}

export async function getJobHistory(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('automation_runs')
    .select(runSelect)
    .eq('user_id', userId)
    .order('started_at', { ascending: false });

  if (filters.jobId) query = query.eq('job_id', filters.jobId);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function runJob(userId, job) {
  const client = requireSupabase();
  const startedAt = new Date().toISOString();

  const { data: run, error: runError } = await client
    .from('automation_runs')
    .insert({
      user_id: userId,
      job_id: job.id,
      started_at: startedAt,
        status: 'queued',
        retry_count: Number(job.retry_count || 0),
        max_retry: Number(job.max_retry || 3),
        result: {
        phase: 'queued',
        message: 'Automation job queued.',
      },
    })
    .select(runSelect)
    .single();

  if (runError) throw runError;

  await client
    .from('automation_runs')
    .update({
      status: 'running',
      result: {
        phase: 'running',
        message: 'Automation job is running through the internal runner.',
      },
    })
    .eq('id', run.id);

  try {
    const runnerResult = await runAutomationJob(userId, job);
    const finishedAt = new Date().toISOString();

    const { data: updatedRun, error: updateRunError } = await client
      .from('automation_runs')
      .update({
        finished_at: finishedAt,
        status: 'success',
        result: {
          phase: 'finished',
          ...runnerResult,
        },
        error: null,
      })
      .eq('id', run.id)
      .select(runSelect)
      .single();

    if (updateRunError) throw updateRunError;

    const { error: jobError } = await client
      .from('automation_jobs')
      .update({
        last_run: finishedAt,
        next_run: calculateNextRun(job.schedule),
        status: job.status === 'failed' ? 'active' : job.status,
        retry_count: 0,
        last_error: null,
      })
      .eq('id', job.id);

    if (jobError) throw jobError;
    return updatedRun;
  } catch (error) {
    const finishedAt = new Date().toISOString();

    const { data: failedRun, error: updateRunError } = await client
      .from('automation_runs')
      .update({
        finished_at: finishedAt,
        status: 'failed',
        retry_count: nextRetryCount(job),
        max_retry: Number(job.max_retry || 3),
        last_error: error.message,
        result: {
          phase: 'failed',
          type: job.type,
          target: job.target || {},
        },
        error: error.message,
      })
      .eq('id', run.id)
      .select(runSelect)
      .single();

    if (updateRunError) throw updateRunError;

    const { error: jobError } = await client
      .from('automation_jobs')
      .update({
        last_run: finishedAt,
        next_run: calculateNextRun(job.schedule),
        status: canRetry(job) ? 'active' : 'failed',
        retry_count: nextRetryCount(job),
        last_error: error.message,
      })
      .eq('id', job.id);

    if (jobError) throw jobError;
    await createNotification(userId, {
      type: 'automation_failed',
      channel: 'telegram',
      title: `Automation failed: ${job.name}`,
      message: error.message,
      metadata: {
        job_id: job.id,
        run_id: run.id,
        retry_count: nextRetryCount(job),
        can_retry: canRetry(job),
      },
    });
    return failedRun;
  }
}

export function getAutomationStats(jobs, runs) {
  const today = new Date().toISOString().slice(0, 10);
  const todayRuns = runs.filter((run) => String(run.started_at || '').slice(0, 10) === today).length;
  const successRuns = runs.filter((run) => run.status === 'success').length;
  const failedRuns = runs.filter((run) => run.status === 'failed').length;
  const failedJobs = jobs.filter((job) => job.status === 'failed').length;
  const generatedCount = runs.filter((run) => (
    run.status === 'success'
    && ['agent_execution', 'workflow_execution'].includes(run.result?.kind)
  )).length;
  const collectedCount = runs.reduce((sum, run) => (
    run.result?.kind === 'collector_execution'
      ? sum + Number(run.result?.items_found || 0)
      : sum
  ), 0);

  return {
    jobs: jobs.length,
    activeJobs: jobs.filter((job) => job.status === 'active').length,
    todayRuns,
    successRuns,
    successRate: runs.length ? Math.round((successRuns / runs.length) * 100) : 0,
    failedJobs,
    failedRuns,
    generatedCount,
    collectedCount,
  };
}

function calculateNextRun(schedule) {
  const parsed = typeof schedule === 'string' ? parseJsonField(schedule, {}) : schedule || {};
  const frequency = parsed.frequency || 'manual';
  if (frequency === 'manual') return null;
  const next = new Date();
  if (frequency === 'hourly') next.setHours(next.getHours() + 1);
  if (frequency === 'daily') next.setDate(next.getDate() + 1);
  if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  return next.toISOString();
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  return JSON.parse(value);
}
