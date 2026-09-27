import React from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { Amplify } from 'aws-amplify';
import '@fontsource-variable/inter';
import '@aws-amplify/ui-react/styles.css';
import { Authenticator } from '@aws-amplify/ui-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import theme from './theme';
import HomePage from './HomePage';
import SettingsPage from './SettingsPage';
import LastExceptionPage from './LastExceptionPage';
import { DebugModeProvider } from './providers/DebugModeProvider';
import MemoriesPage from './MemoriesPage';
import LocationsPage from './LocationsPage';
import SimsPage from './SimsPage';
import { SnackBarProvider } from './providers/SnackBarProvider';
import { AISettingsProvider } from './providers/AISettingsProvider';
import { VersionsProvider } from './providers/VersionsProvider';
import { ModUpdateProvider } from './providers/ModUpdateProvider';
import { AudioContextProvider } from './providers/AudioContextProvider';
import { VoiceInputProvider } from './providers/VoiceInputProvider';
import { WebsocketProvider } from './providers/WebsocketProvider';
import 'aws-amplify/auth/enable-oauth-listener';
import { AuthProvider } from './providers/AuthProvider';
import { AmplifyConfig } from './AmplifyConfig';
import OnlineMappingBrowser from './components/OnlineMappingBrowser';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { rendererTiers } from './tiers/merge';

Amplify.configure(AmplifyConfig);

const router = createMemoryRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        path: '/',
        element: <HomePage />,
      },
      {
        path: '/mapping-browser',
        element: <OnlineMappingBrowser />,
      },
      {
        path: '/settings',
        element: <SettingsPage />,
      },
      {
        path: '/sims',
        element: <SimsPage />,
      },
      {
        path: '/locations',
        element: <LocationsPage />,
      },
      {
        path: '/memories',
        element: <MemoriesPage />,
      },
      {
        path: '/last-exception',
        element: <LastExceptionPage />,
      },
      // The build tiers' pages (dev: the scenario tester, AI log, log viewer, ...)
      ...rendererTiers.routes,
    ],
  },
]);

Object.defineProperty(window.history, 'replaceState', {
  configurable: true,
  value: () => {},
});

const queryClient = new QueryClient();

// The build tiers' providers (dev: the scenario tester's chat generation) wrap the router
// inside the core ones, in tier order
const routerWithTierProviders = rendererTiers.providers.reduceRight<React.ReactNode>(
  (children, TierProvider) => <TierProvider>{children}</TierProvider>,
  <DebugModeProvider>
    <RouterProvider router={router} />
  </DebugModeProvider>,
);

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
root.render(
  <AppErrorBoundary>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Authenticator.Provider>
        <React.StrictMode>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <SnackBarProvider>
                <WebsocketProvider>
                  <VersionsProvider>
                    <ModUpdateProvider>
                      <AISettingsProvider>
                        <AudioContextProvider>
                          <VoiceInputProvider>{routerWithTierProviders}</VoiceInputProvider>
                        </AudioContextProvider>
                      </AISettingsProvider>
                    </ModUpdateProvider>
                  </VersionsProvider>
                </WebsocketProvider>
              </SnackBarProvider>
            </AuthProvider>
          </QueryClientProvider>
        </React.StrictMode>
      </Authenticator.Provider>
    </ThemeProvider>
  </AppErrorBoundary>,
);
