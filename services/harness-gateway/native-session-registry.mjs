/* global Buffer */
import { randomBytes } from 'node:crypto';

const BOOTSTRAP_ID = /^[A-Za-z0-9_-]{32,96}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function bearerExpiryMs(authorization, now) {
  try {
    const token = String(authorization).replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    const expiry = Number(payload.exp) * 1000;
    return Number.isFinite(expiry) ? expiry : now + 15 * 60_000;
  } catch {
    return now + 15 * 60_000;
  }
}

export function createNativeSessionRegistry({ now = () => Date.now(), bootstrapTtlMs = 10 * 60_000 } = {}) {
  const bootstraps = new Map();
  const sessions = new Map();

  function sweep() {
    const current = now();
    for (const [id, value] of bootstraps) if (value.expiresAt <= current) bootstraps.delete(id);
    for (const [id, value] of sessions) if (value.expiresAt <= current) sessions.delete(id);
  }

  return Object.freeze({
    create({ delegatedAuthorization, userId, projectId = null }) {
      sweep();
      if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(String(delegatedAuthorization || ''))) {
        return { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' };
      }
      if (!userId) return { ok: false, code: 'USER_ID_REQUIRED' };
      const bootstrapId = randomBytes(32).toString('base64url');
      bootstraps.set(bootstrapId, {
        delegatedAuthorization,
        userId,
        projectId,
        createdAt: now(),
        expiresAt: now() + bootstrapTtlMs,
      });
      return { ok: true, bootstrapId, expiresIn: Math.floor(bootstrapTtlMs / 1000) };
    },

    bind(bootstrapId, sessionId) {
      sweep();
      if (!BOOTSTRAP_ID.test(String(bootstrapId || ''))) return { ok: false, code: 'BOOTSTRAP_ID_INVALID' };
      if (!SESSION_ID.test(String(sessionId || ''))) return { ok: false, code: 'NATIVE_SESSION_ID_INVALID' };
      const context = bootstraps.get(bootstrapId);
      if (!context) return { ok: false, code: 'NATIVE_BOOTSTRAP_EXPIRED' };
      const existing = sessions.get(sessionId);
      if (existing && existing.userId !== context.userId) {
        return { ok: false, code: 'NATIVE_SESSION_ALREADY_BOUND' };
      }
      bootstraps.delete(bootstrapId);
      const expiresAt = Math.min(context.expiresAt + 24 * 60 * 60_000, bearerExpiryMs(context.delegatedAuthorization, now()));
      if (expiresAt <= now()) return { ok: false, code: 'DELEGATED_AUTHORIZATION_EXPIRED' };
      sessions.set(sessionId, { ...context, boundAt: now(), expiresAt });
      return { ok: true, userId: context.userId, projectId: context.projectId, expiresAt };
    },

    read(sessionId) {
      sweep();
      if (!SESSION_ID.test(String(sessionId || ''))) return { ok: false, code: 'NATIVE_SESSION_ID_INVALID' };
      const context = sessions.get(sessionId);
      if (!context) return { ok: false, code: 'NATIVE_SESSION_CONTEXT_REQUIRED' };
      return { ok: true, ...context };
    },

    current() {
      sweep();
      const active = [...sessions.values()];
      if (active.length === 0) return { ok: false, code: 'NATIVE_SESSION_CONTEXT_REQUIRED' };
      const withProject = active.filter((context) => context.projectId);
      const candidates = withProject.length > 0 ? withProject : active;
      const latest = candidates.sort((left, right) => (right.boundAt || 0) - (left.boundAt || 0))[0];
      return { ok: true, ...latest };
    },

    counts() {
      sweep();
      return { bootstraps: bootstraps.size, sessions: sessions.size };
    },
  });
}
