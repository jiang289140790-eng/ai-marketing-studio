import { createContext, useContext } from 'react';

export const CampaignContext = createContext(null);

export function useCampaignContext() {
  const value = useContext(CampaignContext);
  if (!value) throw new Error('useCampaignContext must be used inside CampaignContextProvider.');
  return value;
}
