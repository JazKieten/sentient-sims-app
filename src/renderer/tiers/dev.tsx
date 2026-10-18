// The DEV tier's renderer entry (release 4.5): the debug pages (scenario tester, AI log,
// offline memory, log viewer, traits), the Memories window's prompt view, the max response
// length row, the Patreon debug card and the Locations page's Lot Words panel. Listed in tiers.json, so both player builds
// delete it and their generated index.tsx never names it.
import type { RendererTier } from './types';
import ChatPage from '../ChatPage';
import AILogPage from '../AILogPage';
import OfflineMemory from '../OfflineMemory';
import LogViewerPage from '../LogViewerPage';
import TraitsPage from '../TraitsPage';
import { ChatGenerationProvider } from '../providers/ChatGenerationProvider';
import { MemoryTraceDialog } from '../components/MemoryTraceDialog';
import { AiMaxResponseLengthSettingsComponent } from '../settings/AiMaxResponseLengthSettingsComponent';
import PatreonDebug from '../components/PatreonDebug';
import LotWordsCard from '../components/LotWordsCard';

export const devRendererTier: RendererTier = {
  name: 'dev',
  routes: [
    { path: '/traits', element: <TraitsPage /> },
    { path: '/chat', element: <ChatPage /> },
    { path: '/offlinememory', element: <OfflineMemory /> },
    { path: '/logs', element: <LogViewerPage /> },
    { path: '/ai-log', element: <AILogPage /> },
  ],
  navItems: [
    { id: 'offlinememory', label: 'OfflineMemory', path: '/offlinememory' },
    { id: 'chat', label: 'Chat', path: '/chat' },
    { id: 'traits', label: 'Traits', path: '/traits' },
    { id: 'ai-log', label: 'AI Log', path: '/ai-log' },
  ],
  settingsRows: [{ id: 'ai-max-response-length', Component: AiMaxResponseLengthSettingsComponent, after: 'end' }],
  providers: [ChatGenerationProvider],
  debugCards: [PatreonDebug],
  locationsCards: [LotWordsCard],
  MemoryTraceDialog,
};
