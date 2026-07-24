import { createContext, useContext } from 'react';

export const ConfirmationContext = createContext(null);

export function useConfirmation() {
  const value = useContext(ConfirmationContext);
  if (!value) throw new Error('useConfirmation must be used within ConfirmationProvider.');
  return value;
}
