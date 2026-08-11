// P19 JWT 校验（纯 ESM：浏览器/node:test/Deno 通用；HS256；无任何网络行为）。
//
// 除签名外，还强制校验边界条件（findings：expired/not-yet-valid/wrong
// issuer/wrong audience 一律拒绝；身份只由调用方从已验证 claims 的 subject
// 派生，本模块不解释任何身份字段）：
// - exp 必须是整数且未过期（缺失 exp 也拒绝——绝不接受无过期时间的令牌）；
// - nbf（若存在）必须是整数且不得晚于当前时间；
// - iss 必须精确匹配期望签发者（默认 'supabase'，可经环境覆盖）；
// - aud 必须精确匹配期望受众（默认 'authenticated'，可经环境覆盖）。
//
// 所有失败抛出带 code 的错误：INVALID_TOKEN / TOKEN_EXPIRED /
// TOKEN_NOT_YET_VALID / WRONG_ISSUER / WRONG_AUDIENCE。

export const DEFAULT_JWT_ISSUER = 'supabase';
export const DEFAULT_JWT_AUDIENCE = 'authenticated';

function jwtError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padding = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary = globalThis.atob(b64 + padding);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * 验证 HS256 JWT。`now` 为毫秒时间戳（可注入保证测试确定性）；
 * `leewaySeconds` 允许时钟偏差；`expectedIssuer` / `expectedAudience`
 * 可注入（index.ts 用环境变量覆盖）。
 */
export async function verifyJwtToken(token, secret, {
  now = Date.now(),
  leewaySeconds = 0,
  expectedIssuer = DEFAULT_JWT_ISSUER,
  expectedAudience = DEFAULT_JWT_AUDIENCE,
} = {}) {
  if (typeof token !== 'string' || token.length === 0) throw jwtError('INVALID_TOKEN', 'JWT 令牌缺失。');
  if (typeof secret !== 'string' || secret.length === 0) throw jwtError('INVALID_TOKEN', 'JWT 校验密钥缺失。');
  const parts = token.split('.');
  if (parts.length !== 3) throw jwtError('INVALID_TOKEN', 'JWT 结构无效。');
  const [headerB64, payloadB64, signatureB64] = parts;
  const encoder = new globalThis.TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = decodeBase64Url(signatureB64);
  const valid = await globalThis.crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${headerB64}.${payloadB64}`));
  if (!valid) throw jwtError('INVALID_TOKEN', 'JWT 签名校验失败。');

  let claims;
  try {
    claims = JSON.parse(new globalThis.TextDecoder().decode(decodeBase64Url(payloadB64)));
  } catch {
    throw jwtError('INVALID_TOKEN', 'JWT 载荷不是合法 JSON。');
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw jwtError('INVALID_TOKEN', 'JWT 载荷不是对象。');
  }

  const nowSeconds = Math.floor(now / 1000);
  const exp = claims.exp;
  if (!Number.isInteger(exp)) throw jwtError('TOKEN_EXPIRED', 'JWT 缺少数值型过期时间（exp），已拒绝。');
  if (exp + leewaySeconds <= nowSeconds) throw jwtError('TOKEN_EXPIRED', 'JWT 已过期，已拒绝。');
  if (claims.nbf !== undefined && claims.nbf !== null) {
    if (!Number.isInteger(claims.nbf)) throw jwtError('TOKEN_NOT_YET_VALID', 'JWT nbf 不是数值，已拒绝。');
    if (claims.nbf - leewaySeconds > nowSeconds) throw jwtError('TOKEN_NOT_YET_VALID', 'JWT 尚未生效（nbf 在未来），已拒绝。');
  }
  if (claims.iss !== expectedIssuer) throw jwtError('WRONG_ISSUER', 'JWT 签发者（iss）不匹配，已拒绝。');
  if (claims.aud !== expectedAudience) throw jwtError('WRONG_AUDIENCE', 'JWT 受众（aud）不匹配，已拒绝。');
  return claims;
}
