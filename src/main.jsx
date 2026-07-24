import './utils/safe-headers-init';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './contexts/AuthProvider.jsx';
import { ConfirmationProvider } from './contexts/ConfirmationProvider.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <ConfirmationProvider>
      <App />
    </ConfirmationProvider>
  </AuthProvider>,
);
