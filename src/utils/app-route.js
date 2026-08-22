import { useCallback, useEffect, useState } from 'react';
import { navigationItems } from '../data/navigation.js';

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

export function parseAppRoute(hash = window.location.hash) {
  const route = String(hash || '').replace(/^#\/?/, '');
  const [path = '', queryString = ''] = route.split('?');
  const [pageSegment = 'dashboard', detailSegment = ''] = path.split('/');
  const resolvedPage = legacyAliases[pageSegment] || pageSegment;
  const page = validPages.has(resolvedPage) ? resolvedPage : 'dashboard';
  return {
    page,
    detailId: detailSegment ? decodeURIComponent(detailSegment) : '',
    routeParams: Object.fromEntries(new window.URLSearchParams(queryString)),
  };
}

export function buildAppHash(page = 'dashboard', detailId = '', routeParams = {}) {
  const resolvedPage = legacyAliases[page] || page;
  const safePage = validPages.has(resolvedPage) ? resolvedPage : 'ai';
  const path = detailId
    ? `#/${safePage}/${encodeURIComponent(detailId)}`
    : `#/${safePage}`;
  const query = new window.URLSearchParams(
    Object.entries(routeParams || {}).filter(([, value]) => value !== '' && value != null),
  ).toString();
  return query ? `${path}?${query}` : path;
}

export function useAppRoute() {
  const [route, setRoute] = useState(() => parseAppRoute());

  useEffect(() => {
    if (!window.location.hash || window.location.hash === '#') {
      window.history.replaceState({}, '', buildAppHash(route.page, route.detailId, route.routeParams));
    }

    const handleHashChange = () => setRoute(parseAppRoute());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [route.detailId, route.page, route.routeParams]);

  const navigate = useCallback((page, detailId = '', routeParams = {}) => {
    const nextHash = buildAppHash(page, detailId, routeParams);
    if (window.location.hash === nextHash) {
      setRoute(parseAppRoute(nextHash));
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return { ...route, navigate };
}
