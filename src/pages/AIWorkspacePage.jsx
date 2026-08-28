import { useEffect } from 'react';
import { createHarnessClient, newHarnessRequestId, readHarnessActiveProject } from '../services/harness-client.js';

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
    let active = true;
    const openHarness = async () => {
      try {
        const result = await createHarnessClient().createNativeBootstrap({
          projectId: readHarnessActiveProject(),
          requestId: newHarnessRequestId(),
        });
        if (active && result?.bootstrapId) {
          globalThis.location?.replace?.(`${harnessWebUrl}#ams-bootstrap=${encodeURIComponent(result.bootstrapId)}`);
          return;
        }
      } catch { /* Keep the official Harness available if bootstrap is temporarily unavailable. */ }
      if (active) globalThis.location?.replace?.(harnessWebUrl);
    };
    openHarness();
    return () => { active = false; };
  }, [harnessWebUrl]);

  return null;
}
