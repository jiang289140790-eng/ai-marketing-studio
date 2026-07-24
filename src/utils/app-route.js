import { useCallback, useEffect, useState } from 'react';
import { navigationItems } from '../data/navigation';

const validPages = new Set(navigationItems.map((item) => item.id));

export function parseAppRoute(hash = window.location.hash) {
  const route = String(hash || '').replace(/^#\/?/, '');
  const [pageSegment = 'dashboard', detailSegment = ''] = route.split('/');
  const page = validPages.has(pageSegment) ? pageSegment : 'dashboard';
  return {
    page,
    detailId: detailSegment ? decodeURIComponent(detailSegment) : '',
  };
}

export function buildAppHash(page = 'dashboard', detailId = '') {
  const safePage = validPages.has(page) ? page : 'dashboard';
  return detailId
    ? `#/${safePage}/${encodeURIComponent(detailId)}`
    : `#/${safePage}`;
}

export function useAppRoute() {
  const [route, setRoute] = useState(() => parseAppRoute());

  useEffect(() => {
    if (!window.location.hash || window.location.hash === '#') {
      window.history.replaceState({}, '', buildAppHash(route.page, route.detailId));
    }

    const handleHashChange = () => setRoute(parseAppRoute());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [route.detailId, route.page]);

  const navigate = useCallback((page, detailId = '') => {
    const nextHash = buildAppHash(page, detailId);
    if (window.location.hash === nextHash) {
      setRoute(parseAppRoute(nextHash));
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return { ...route, navigate };
}
