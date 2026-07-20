const SAFE_HEADERS_PATCH_FLAG = '__aiMarketingStudioSafeHeadersPatched';
const SAFE_HEADERS_PROTOTYPE_PATCH_FLAG = '__aiMarketingStudioSafeHeadersPrototypePatched';

export function sanitizeHttpHeaderValue(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '');
}

export function sanitizeHttpHeaderName(name) {
  return String(name ?? '').replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g, '');
}

export function buildSafeHeadersObject(headers) {
  const safeHeaders = {};
  if (!headers) return safeHeaders;

  const setSafeHeader = (key, value) => {
    const safeKey = sanitizeHttpHeaderName(key);
    if (!safeKey) return;
    const safeValue = sanitizeHttpHeaderValue(value);
    if (!safeValue && value !== '') return;
    safeHeaders[safeKey] = safeValue;
  };

  if (isHeadersLike(headers)) {
    headers.forEach((value, key) => setSafeHeader(key, value));
    return safeHeaders;
  }

  if (Array.isArray(headers)) {
    headers.forEach(([key, value]) => setSafeHeader(key, value));
    return safeHeaders;
  }

  Object.entries(headers).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      setSafeHeader(key, value.join(', '));
    } else {
      setSafeHeader(key, value);
    }
  });

  return safeHeaders;
}

export function installSafeHeadersPatch() {
  const NativeHeaders = globalThis.Headers;
  if (!NativeHeaders) return;

  patchNativeHeadersPrototype(NativeHeaders);

  if (NativeHeaders[SAFE_HEADERS_PATCH_FLAG]) return;

  class SafeHeaders extends NativeHeaders {
    constructor(init) {
      super();
      appendInitialHeaders(this, init);
    }

    set(name, value) {
      const safeName = sanitizeHttpHeaderName(name);
      if (!safeName) return;
      try {
        super.set(safeName, sanitizeHttpHeaderValue(value));
      } catch {
        return undefined;
      }
    }

    append(name, value) {
      const safeName = sanitizeHttpHeaderName(name);
      if (!safeName) return;
      try {
        super.append(safeName, sanitizeHttpHeaderValue(value));
      } catch {
        return undefined;
      }
    }
  }

  Object.defineProperty(SafeHeaders, SAFE_HEADERS_PATCH_FLAG, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(SafeHeaders, 'name', {
    value: 'Headers',
    configurable: true,
  });

  globalThis.Headers = SafeHeaders;
}

function patchNativeHeadersPrototype(NativeHeaders) {
  const prototype = NativeHeaders.prototype;
  if (!prototype || prototype[SAFE_HEADERS_PROTOTYPE_PATCH_FLAG]) return;

  const nativeSet = prototype.set;
  const nativeAppend = prototype.append;

  if (typeof nativeSet === 'function') {
    Object.defineProperty(prototype, 'set', {
      configurable: true,
      value(name, value) {
        const safeName = sanitizeHttpHeaderName(name);
        if (!safeName) return undefined;
        try {
          return nativeSet.call(this, safeName, sanitizeHttpHeaderValue(value));
        } catch {
          return undefined;
        }
      },
    });
  }

  if (typeof nativeAppend === 'function') {
    Object.defineProperty(prototype, 'append', {
      configurable: true,
      value(name, value) {
        const safeName = sanitizeHttpHeaderName(name);
        if (!safeName) return undefined;
        try {
          return nativeAppend.call(this, safeName, sanitizeHttpHeaderValue(value));
        } catch {
          return undefined;
        }
      },
    });
  }

  Object.defineProperty(prototype, SAFE_HEADERS_PROTOTYPE_PATCH_FLAG, {
    value: true,
    enumerable: false,
  });
}

function appendInitialHeaders(target, init) {
  if (!init) return;

  if (isHeadersLike(init)) {
    init.forEach((value, key) => target.append(key, value));
    return;
  }

  if (Array.isArray(init)) {
    init.forEach(([key, value]) => target.append(key, value));
    return;
  }

  Object.entries(init).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => target.append(key, item));
    } else {
      target.append(key, value);
    }
  });
}

function isHeadersLike(value) {
  return Boolean(value && typeof value.forEach === 'function' && typeof value.get === 'function');
}
