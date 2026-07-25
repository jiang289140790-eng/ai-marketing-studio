import { useCallback, useEffect, useState } from 'react';
import { navigationItems } from '../data/navigation.js';

const validPages = new Set(navigationItems.map((item) => item.id));
const legacyAliases = { aiworks: 'generation' };

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
  const safePage = validPages.has(page) ? page : 'dashboard';
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
