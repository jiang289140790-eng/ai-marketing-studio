import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCampaignContext, listCampaigns, selectActiveCampaignFromList, setActiveCampaign } from '../services/campaign-context-service';
import { useAuth } from './auth-context';
import { CampaignContext } from './campaign-context';

function preferenceKey(userId) {
  return `ai-marketing-studio-active-campaign:${userId}`;
}

function routeCampaignId() {
  const query = String(window.location.hash || '').split('?')[1] || '';
  return new window.URLSearchParams(query).get('campaign_id') || '';
}

export function CampaignContextProvider({ children }) {
  const { userId } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [activeCampaign, setActiveCampaignState] = useState(null);
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async (preferredId = '') => {
    if (!userId) {
      setCampaigns([]);
      setActiveCampaignState(null);
      setContext(null);
      return null;
    }
    setLoading(true);
    setError('');
    try {
      const rows = await listCampaigns(userId);
      const rememberedId = window.sessionStorage.getItem(preferenceKey(userId)) || '';
      const selected = selectActiveCampaignFromList(rows, preferredId || routeCampaignId() || rememberedId);
      setCampaigns(rows);
      setActiveCampaignState(selected);
      if (!selected) {
        setContext(null);
        return null;
      }
      window.sessionStorage.setItem(preferenceKey(userId), selected.id);
      const nextContext = await getCampaignContext(userId, selected.id);
      setContext(nextContext);
      return nextContext;
    } catch (nextError) {
      setError(nextError.message || '运营活动上下文读取失败。');
      setContext(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handleHashChange = () => {
      const requestedId = routeCampaignId();
      if (requestedId && requestedId !== activeCampaign?.id) refresh(requestedId);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [activeCampaign?.id, refresh]);

  const selectCampaign = useCallback(async (campaignId) => {
    const selected = await setActiveCampaign(userId, campaignId);
    window.sessionStorage.setItem(preferenceKey(userId), selected.id);
    setActiveCampaignState(selected);
    setLoading(true);
    try {
      setContext(await getCampaignContext(userId, selected.id));
    } finally {
      setLoading(false);
    }
    return selected;
  }, [userId]);

  const value = useMemo(() => ({
    campaigns,
    activeCampaign,
    activeCampaignId: activeCampaign?.id || '',
    campaignContext: context,
    progress: context?.progress || null,
    blockingItems: context?.blockingItems || [],
    loading,
    error,
    refreshCampaignContext: refresh,
    selectCampaign,
  }), [activeCampaign, campaigns, context, error, loading, refresh, selectCampaign]);

  return <CampaignContext.Provider value={value}>{children}</CampaignContext.Provider>;
}
