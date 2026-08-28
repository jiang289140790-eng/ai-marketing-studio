import { useEffect } from 'react';

const DEFAULT_HARNESS_WEB_URL = 'https://harness-web.47-251-244-196.sslip.io';

function getHarnessWebUrl() {
  return String(
    import.meta.env.VITE_DSH_WEB_URL
      || import.meta.env.VITE_DEEPSEEK_HARNESS_WEB_URL
      || DEFAULT_HARNESS_WEB_URL,
  ).trim().replace(/\/$/, '');
}

/**
 * The AI workspace is the official DeepSeek Harness Web application itself.
 * AMS must not reproduce, wrap, decorate, or productize the Harness homepage.
 */
export function AIWorkspacePage() {
  const harnessWebUrl = getHarnessWebUrl();

  useEffect(() => {
    if (!harnessWebUrl) return;
    globalThis.location?.replace?.(harnessWebUrl);
  }, [harnessWebUrl]);

  return null;
}
