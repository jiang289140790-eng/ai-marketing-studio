// G1 worker 私有 Storage 适配器（可注入，本地确定性测试用内存 fake 替换）。
//
// - 产物永远写入私有 bucket 的确定性路径
//   {user_id}/{project_id}/{job_id}/v{version}/{sha12}.{ext}；
//   SQL 边界（g1_complete_attempt）会对该路径做精确正则校验，任何偏离都会
//   fail closed；
// - i2v 引用素材：worker 有界下载 → 校验 → 上传到私有 bucket 的
//   references/{job_id}/{attempt_id}/{sha12}.{ext} → 生成短时签名 URL 交给
//   provider（provider 只拿到限时 URL，拿不到任何 Secret）；
// - 浏览器永远只通过 Edge Function 拿短时签名 URL，绝不公开 bucket。

/* global AbortController */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 由 MIME 派生有界扩展名（未知 → bin）。 */
export function extensionForMime(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  };
  return map[String(mime || '').toLowerCase()] || 'bin';
}

function boundedStorageError(code, message) {
  return Object.assign(new Error(String(message).slice(0, 240)), { code });
}

export function createStorageAdapter({ supabase, bucket = 'g1-generation-artifacts', fetchImpl = globalThis.fetch }) {
  async function uploadBuffer(path, buffer, mime) {
    const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
      contentType: String(mime || 'application/octet-stream').slice(0, 120),
      upsert: false,
    });
    if (error) throw boundedStorageError('STORAGE_UPLOAD_FAILED', `Storage upload failed: ${String(error?.message || '').slice(0, 160)}`);
    return path;
  }

  return {
    /**
     * 上传已完成产物。path 必须由 SQL 边界接受
     * （{user}/{project}/{job}/v{version}/{sha12}.{ext}）。
     */
    async uploadArtifact({ user, project, jobId, version, contentSha, mime, buffer }) {
      const extension = extensionForMime(mime);
      const path = `${user}/${project}/${jobId}/v${version}/${contentSha.slice(0, 12)}.${extension}`;
      await uploadBuffer(path, buffer, mime);
      return path;
    },

    /** 有界下载引用素材字节（从 assets.url / 任意 provider 源 URL）。 */
    async downloadReference({ url, maxBytes, timeoutMs = 120_000 }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
        if (!response.ok) throw boundedStorageError('REFERENCE_DOWNLOAD_FAILED', `Reference download failed with HTTP ${response.status}.`);
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > maxBytes) throw boundedStorageError('REFERENCE_TOO_LARGE', 'Reference asset exceeded the bounded size.');
        const mime = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 80) || 'application/octet-stream';
        if (!response.body) throw boundedStorageError('REFERENCE_DOWNLOAD_FAILED', 'Reference download returned no body.');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            try { await reader.cancel(); } catch { /* best-effort */ }
            throw boundedStorageError('REFERENCE_TOO_LARGE', 'Reference asset exceeded the bounded size.');
          }
          chunks.push(value);
        }
        return { buffer: Buffer.concat(chunks), mime };
      } catch (error) {
        if (error?.name === 'AbortError') throw boundedStorageError('REFERENCE_DOWNLOAD_TIMEOUT', 'Reference download timed out.');
        if (error?.code) throw error;
        throw boundedStorageError('REFERENCE_DOWNLOAD_FAILED', 'Reference download failed.');
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * 上传引用素材到私有 bucket 并生成 provider 可用短时签名 URL。
     * 返回 {url, path, content_sha256, mime, byte_size}。
     */
    async prepareReference({ user, project, jobId, attemptId, buffer, mime, signedUrlSeconds = 900 }) {
      const contentSha = sha256Hex(buffer);
      const extension = extensionForMime(mime);
      const path = `references/${user}/${project}/${jobId}/${attemptId}/${contentSha.slice(0, 12)}.${extension}`;
      await uploadBuffer(path, buffer, mime);
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, signedUrlSeconds);
      if (error || !data?.signedUrl) throw boundedStorageError('STORAGE_SIGNED_URL_FAILED', 'Reference signed URL creation failed.');
      return { url: data.signedUrl, path, content_sha256: contentSha, mime, byte_size: buffer.byteLength };
    },
  };
}
