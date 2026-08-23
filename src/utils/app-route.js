import { useCallback, useEffect, useState } from 'react';
/* global URL, URLSearchParams */
import { navigationItems } from '../data/navigation.js';

// 任务信息架构规范路由（一等路由，真实可解析，测试必须使用这三个路径）：
//   /tasks/new                 → 新任务页（无 taskId 时当前任务为 null 的真实空状态）
//   /tasks/<taskId>            → 任务执行详情
//   /tasks/<taskId>/results    → 任务结果与审核
// 旧 hash 路由（#/ai、#/ai-execution/<id>、#/ai-results/<id>、#/dashboard 等）
// 仅作为兼容重定向：加载时被 replaceState 到对应规范路由，不参与渲染。
// GitHub Pages 上直接打开/硬刷新规范路径时由 public/404.html 重写到
// #/tasks/... 哈希，本解析器再把它恢复成规范路径 URL。

const validPages = new Set(navigationItems.map((item) => item.id));
const legacyAliases = { dashboard: 'ai', plan: 'campaigns', aiworks: 'generation' };
const harnessContextSources = new Set(['accounts', 'analytics', 'data-analytics', 'publish', 'generation', 'research', 'knowledge']);
const harnessContextEntities = new Set(['account', 'account-list', 'analytics-summary', 'publish-queue', 'publish-task', 'generation-workspace', 'research-project', 'knowledge-vault']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

export function buildHarnessContextParams({ source, entity, entityId = '', campaignId = '', intent = '' } = {}) {
  const safeSource = harnessContextSources.has(source) ? source : '';
  const safeEntity = harnessContextEntities.has(entity) ? entity : '';
  if (!safeSource || !safeEntity) return {};
  const params = { source: safeSource, entity: safeEntity };
  if (uuidPattern.test(entityId)) params.entity_id = entityId.toLowerCase();
  if (uuidPattern.test(campaignId)) params.campaign_id = campaignId.toLowerCase();
  const safeIntent = boundedText(intent, 300);
  if (safeIntent) params.intent = safeIntent;
  return params;
}

export function parseHarnessContextParams(routeParams = {}) {
  return buildHarnessContextParams({
    source: routeParams.source,
    entity: routeParams.entity,
    entityId: routeParams.entity_id,
    campaignId: routeParams.campaign_id,
    intent: routeParams.intent,
  });
}

function serializeParams(routeParams = {}) {
  const query = new URLSearchParams(
    Object.entries(routeParams || {}).filter(([, value]) => value !== '' && value != null),
  ).toString();
  return query ? `?${query}` : '';
}

function parseQueryString(queryString = '') {
  return Object.fromEntries(new URLSearchParams(queryString));
}

function baseUrl() {
  return String(import.meta.env?.BASE_URL || '/');
}

function stripBase(pathname) {
  const base = baseUrl();
  let rest = String(pathname || '');
  if (base && base !== '/' && rest.startsWith(base)) rest = rest.slice(base.length);
  if (rest.startsWith('/')) rest = rest.slice(1);
  return rest;
}

/**
 * 把任意页面标识解析为规范任务路由三元组。
 *  - 'tasks' + view（new/execution/results）；
 *  - 旧页面 id 'ai' / 'ai-execution' / 'ai-results'（及其别名 dashboard）迁移到 tasks。
 */
function resolveCanonical(page, detailId, view) {
  const resolved = legacyAliases[page] || page;
  if (resolved === 'ai') {
    return { page: 'tasks', view: detailId ? 'execution' : 'new', detailId: detailId || '' };
  }
  if (resolved === 'ai-execution') {
    return { page: 'tasks', view: detailId ? 'execution' : 'new', detailId: detailId || '' };
  }
  if (resolved === 'ai-results') {
    return { page: 'tasks', view: detailId ? 'results' : 'new', detailId: detailId || '' };
  }
  if (resolved === 'tasks') {
    const resolvedView = view || (detailId ? 'execution' : 'new');
    return { page: 'tasks', view: resolvedView, detailId: resolvedView === 'new' ? '' : detailId };
  }
  return { page: resolved, view: '', detailId: detailId || '' };
}

function parseTaskSegments(segments, queryString) {
  const params = parseQueryString(queryString);
  if (segments.length === 1) return { page: 'tasks', view: 'new', detailId: '', routeParams: params };
  if (segments[1] === 'new') return { page: 'tasks', view: 'new', detailId: '', routeParams: params };
  if (segments.length === 2) {
    return { page: 'tasks', view: 'execution', detailId: decodeURIComponent(segments[1]), routeParams: params };
  }
  if (segments.length === 3 && segments[2] === 'results') {
    return { page: 'tasks', view: 'results', detailId: decodeURIComponent(segments[1]), routeParams: params };
  }
  // 未知的任务子路径不猜测：回到新任务页真实空状态。
  return { page: 'tasks', view: 'new', detailId: '', routeParams: params };
}

/**
 * 解析当前 URL 为规范路由。
 *  - 优先解析 hash（应用内哈希路由 + 404.html 重写出的 #/tasks/...）；
 *  - hash 为空时解析规范路径 /tasks/...；
 *  - 其余路径（站点根路径等）回落到新任务页（规范默认入口）。
 * 兼容旧的 #/ai、#/ai-execution/<id>、#/ai-results/<id>、#/dashboard 哈希：
 * 一律迁移为 tasks 规范路由，由 useAppRoute 在挂载时 replaceState 重定向。
 *
 * @param {string} [hash] 显式 hash（测试注入）；缺省读 window.location.hash
 * @param {object} [locationExtra] 测试注入 { pathname, search }；缺省读 window.location
 */
export function parseAppRoute(hash = window.location.hash, locationExtra = null) {
  const source = locationExtra || window.location || {};
  const hashValue = String(hash || '');
  const route = hashValue.replace(/^#\/?/, '');
  if (route) {
    const [path = '', queryString = ''] = route.split('?');
    const segments = path.split('/').filter(Boolean);
    if (segments[0] === 'tasks') return parseTaskSegments(segments, queryString);
    const [pageSegment = 'dashboard', detailSegment = ''] = path.split('/');
    const resolvedPage = legacyAliases[pageSegment] || pageSegment;
    if (resolvedPage === 'ai' || resolvedPage === 'ai-execution' || resolvedPage === 'ai-results') {
      return { ...resolveCanonical(resolvedPage, detailSegment ? decodeURIComponent(detailSegment) : '', ''), routeParams: parseQueryString(queryString) };
    }
    if (validPages.has(resolvedPage)) {
      return {
        page: resolvedPage,
        detailId: detailSegment ? decodeURIComponent(detailSegment) : '',
        view: '',
        routeParams: parseQueryString(queryString),
      };
    }
    // 未知页面不猜测：回落到新任务页真实空状态（规范默认入口）。
    return { page: 'tasks', view: 'new', detailId: '', routeParams: parseQueryString(queryString) };
  }
  // hash 为空：规范路径 /tasks/... 或默认入口。
  const rest = stripBase(source.pathname);
  if (rest === 'tasks' || rest.startsWith('tasks/')) {
    const segments = rest.split('/').filter(Boolean);
    return parseTaskSegments(segments, String(source.search || '').replace(/^\?/, ''));
  }
  return { page: 'tasks', view: 'new', detailId: '', routeParams: parseQueryString(String(source.search || '').replace(/^\?/, '')) };
}

/**
 * 构建规范路由 URL（相对形式）：
 *  - 任务页 → 规范路径（/ai-marketing-studio/tasks/...，含 BASE_URL）；
 *  - 其他页 → 哈希（#/page/<detail>?...）。
 * 旧页面 id（ai/ai-execution/ai-results/dashboard）自动迁移到规范任务路径。
 */
export function buildAppRoute(page = 'dashboard', detailId = '', routeParams = {}, view = '') {
  const canonical = resolveCanonical(page, detailId, view);
  if (canonical.page === 'tasks') {
    const path = canonical.view === 'new' || !canonical.detailId
      ? 'tasks/new'
      : canonical.view === 'results'
        ? `tasks/${encodeURIComponent(canonical.detailId)}/results`
        : `tasks/${encodeURIComponent(canonical.detailId)}`;
    return `${baseUrl()}${path}${serializeParams(canonical.routeParams || routeParams)}`;
  }
  const safePage = validPages.has(canonical.page) ? canonical.page : 'ai';
  const path = canonical.detailId
    ? `#/${safePage}/${encodeURIComponent(canonical.detailId)}`
    : `#/${safePage}`;
  return `${path}${serializeParams(canonical.routeParams || routeParams)}`;
}

// 兼容别名：历史测试/调用点使用的构建函数，返回与 buildAppRoute 相同的规范 URL。
export function buildAppHash(page = 'dashboard', detailId = '', routeParams = {}, view = '') {
  return buildAppRoute(page, detailId, routeParams, view);
}

function absoluteUrl(relative, origin) {
  try {
    return new URL(relative, `${origin}${baseUrl()}`).href;
  } catch {
    return `${origin}${baseUrl()}#/`;
  }
}

export function useAppRoute() {
  const [route, setRoute] = useState(() => parseAppRoute());

  // 挂载时规范化一次：旧哈希/规范哈希/空 URL 一律 replaceState 到规范形式，
  // 使 GitHub Pages 硬刷新（404.html → #/tasks/... → 本重写）与直达路径收敛
  // 到同一规范 URL，且 taskId 全程保持。
  useEffect(() => {
    const canonical = buildAppRoute(route.page, route.detailId, route.routeParams, route.view);
    const target = absoluteUrl(canonical, window.location.origin);
    if (window.location.href !== target) {
      window.history.replaceState({}, '', target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const refresh = () => setRoute(parseAppRoute(undefined, window.location));
    window.addEventListener('hashchange', refresh);
    window.addEventListener('popstate', refresh);
    return () => {
      window.removeEventListener('hashchange', refresh);
      window.removeEventListener('popstate', refresh);
    };
  }, []);

  const navigate = useCallback((page, detailId = '', routeParams = {}, view = '') => {
    const nextUrl = buildAppRoute(page, detailId, routeParams, view);
    const target = absoluteUrl(nextUrl, window.location.origin);
    if (window.location.href === target) {
      setRoute(parseAppRoute(undefined, window.location));
      return;
    }
    window.history.pushState({}, '', target);
    setRoute(parseAppRoute(undefined, window.location));
  }, []);

  return { ...route, navigate };
}
