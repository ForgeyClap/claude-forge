/**
 * Forge Workspace — routing.
 *
 * HashRouter, deliberately. A built prototype has to open by double-clicking
 * dist/index.html from any folder, on any machine, with no server rewriting
 * paths. That rules out BrowserRouter.
 *
 * Every route renders inside <AppShell>, which owns the chrome: sidebar, topbar,
 * inspector, dock, command palette and toasts. A view only ever renders its own
 * content area.
 *
 * WP11 — every view is `React.lazy` + `import()`, one chunk per route. This is
 * a build-level change only: the single ~506 kB entry chunk (Vite's own >500 kB
 * warning) previously shipped every view's code and CSS up front regardless of
 * which route was actually visited. Splitting it means the FIRST paint of any
 * one route now only pays for that route's own chunk, not all thirteen. Vite's
 * async-chunk CSS handling loads a dynamic chunk's stylesheet before the chunk
 * resolves, so this changes network/parse timing only — never a rendered pixel
 * (see mission/visual-review/WP11-a11y-perf-report.md for the before/after
 * screenshot proof). The Suspense fallback reuses the design system's existing
 * EmptyState primitive (compact) rather than inventing a new loading look — the
 * app had no prior Suspense boundary to preserve, and on the same-origin local
 * gateway a chunk fetch resolves before a human eye or a settled screenshot
 * would ever catch it rendered.
 */

import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import AppShell from '@/components/shell/AppShell';
import { EmptyState } from '@/components/primitives';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';

const ActivityView = lazy(() => import('@/views/activity/ActivityView'));
const AgentsView = lazy(() => import('@/views/agents/AgentsView'));
const ArtifactsView = lazy(() => import('@/views/artifacts/ArtifactsView'));
const ChatView = lazy(() => import('@/views/chat/ChatView'));
const DiscordView = lazy(() => import('@/views/discord/DiscordView'));
const FilesView = lazy(() => import('@/views/files/FilesView'));
const HomeView = lazy(() => import('@/views/home/HomeView'));
const MissionControlView = lazy(() => import('@/views/mission/MissionControlView'));
const ProjectOverviewView = lazy(() => import('@/views/projects/ProjectOverviewView'));
const ProjectsView = lazy(() => import('@/views/projects/ProjectsView'));
const SettingsView = lazy(() => import('@/views/settings/SettingsView'));
const TasksView = lazy(() => import('@/views/tasks/TasksView'));
const TestsView = lazy(() => import('@/views/tests/TestsView'));
const ThemeShowcaseView = lazy(() => import('@/views/theme/ThemeShowcaseView'));

/** Same EmptyState primitive every other quiet region uses — no new visual. */
function RouteFallback() {
  return <EmptyState icon="Loader" title="Loading view…" compact />;
}

export default function App() {
  return (
    <PrototypeProvider>
      <HashRouter>
        <AppShell>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomeView />} />
              <Route path="/projects" element={<ProjectsView />} />
              <Route path="/project" element={<ProjectOverviewView />} />
              <Route path="/chat" element={<ChatView />} />
              <Route path="/mission" element={<MissionControlView />} />
              <Route path="/agents" element={<AgentsView />} />
              <Route path="/tasks" element={<TasksView />} />
              <Route path="/files" element={<FilesView />} />
              <Route path="/artifacts" element={<ArtifactsView />} />
              <Route path="/tests" element={<TestsView />} />
              <Route path="/activity" element={<ActivityView />} />
              <Route path="/discord" element={<DiscordView />} />
              <Route path="/settings" element={<SettingsView />} />
              <Route path="/theme" element={<ThemeShowcaseView />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </AppShell>
      </HashRouter>
    </PrototypeProvider>
  );
}
