// G1 worker → Supabase service-role RPC 适配器（可注入，本地确定性测试用内存
// fake 替换）。全部调用显式 supabase.schema('api').rpc(...)；客户端代码
// 绝不命名 ams_private。Secret 只存在于 service-role 密钥（环境/文件挂载），
// 绝不返回、记录或暴露。

export function createDbAdapter({ supabase, logger: _logger = console }) {
  async function rpc(name, args) {
    const { data, error } = await supabase.schema('api').rpc(name, args);
    if (error) {
      const message = String(error?.message || '');
      const code = [...message.matchAll(/G1_([A-Z_]+)/g)].at(-1)?.[1] || 'G1_RPC_FAILED';
      const mapped = Object.assign(new Error(message.slice(0, 240)), { code });
      throw mapped;
    }
    return data;
  }

  return {
    /** 认领（含 lease 过期对账）；返回 {ok, claimed: [...]}。 */
    async claimJobs({ workerId, maxJobs, leaseSeconds }) {
      const data = await rpc('g1_claim_jobs', {
        p_worker_id: workerId,
        p_max_jobs: maxJobs,
        p_lease_seconds: leaseSeconds,
      });
      return { ok: data?.ok === true, claimed: Array.isArray(data?.claimed) ? data.claimed : [] };
    },
    /** 记录 provider 提交（attempt → submitted）。 */
    async markProviderSubmitted({ jobId, attemptId, workerId, providerTaskId, providerState }) {
      return rpc('g1_mark_provider_submitted', {
        p_job_id: jobId,
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_provider_task_id: providerTaskId,
        p_provider_state: providerState,
      });
    },
    async heartbeat({ jobId, attemptId, workerId, leaseSeconds }) {
      return rpc('g1_heartbeat', {
        p_job_id: jobId,
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      });
    },
    async reportPoll({ jobId, attemptId, workerId, providerStatus, providerState }) {
      return rpc('g1_report_poll', {
        p_job_id: jobId,
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_provider_status: providerStatus,
        p_provider_state: providerState,
      });
    },
    async completeAttempt({ jobId, attemptId, workerId, artifact }) {
      return rpc('g1_complete_attempt', {
        p_job_id: jobId,
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_artifact: artifact,
      });
    },
    async failAttempt({ jobId, attemptId, workerId, code, diagnostics, retryEligible }) {
      return rpc('g1_fail_attempt', {
        p_job_id: jobId,
        p_attempt_id: attemptId,
        p_worker_id: workerId,
        p_code: code,
        p_diagnostics: diagnostics,
        p_retry_eligible: retryEligible,
      });
    },
  };
}

/** 判定一次 RPC 失败是否为 lease 丢失（另一 worker 接管 / 作业被撤销）。 */
export function isLeaseLostError(error) {
  return error?.code === 'G1_LEASE_LOST' || error?.code === 'G1_ATTEMPT_TERMINAL'
    || error?.code === 'G1_ATTEMPT_STATE_INVALID' || error?.code === 'G1_ATTEMPT_NOT_FOUND';
}
