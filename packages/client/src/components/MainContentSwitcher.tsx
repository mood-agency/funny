import { lazy } from 'react';

const AddProjectView = lazy(() =>
  import('@/components/AddProjectView').then((m) => ({ default: m.AddProjectView })),
);
const AllThreadsView = lazy(() =>
  import('@/components/AllThreadsView').then((m) => ({ default: m.AllThreadsView })),
);
const AnalyticsView = lazy(() =>
  import('@/components/AnalyticsView').then((m) => ({ default: m.AnalyticsView })),
);
const AutomationInboxView = lazy(() =>
  import('@/components/AutomationInboxView').then((m) => ({ default: m.AutomationInboxView })),
);
const DesignsListView = lazy(() =>
  import('@/components/DesignsListView').then((m) => ({ default: m.DesignsListView })),
);
const DesignView = lazy(() =>
  import('@/components/DesignView').then((m) => ({ default: m.DesignView })),
);
const GeneralSettingsView = lazy(() =>
  import('@/components/GeneralSettingsView').then((m) => ({ default: m.GeneralSettingsView })),
);
const LiveColumnsView = lazy(() =>
  import('@/components/LiveColumnsView').then((m) => ({ default: m.LiveColumnsView })),
);
const SettingsDetailView = lazy(() =>
  import('@/components/SettingsDetailView').then((m) => ({ default: m.SettingsDetailView })),
);
const TestRunnerPane = lazy(() =>
  import('@/components/TestRunnerPane').then((m) => ({ default: m.TestRunnerPane })),
);
// Eager-prefetch ThreadView at module load — it's the primary view users
// always see, so we want the chunk download in flight before render.
const threadViewImport = import('@/components/ThreadView').then((m) => ({ default: m.ThreadView }));
const ThreadView = lazy(() => threadViewImport);

interface MainContentSwitcherProps {
  generalSettingsOpen: boolean;
  settingsOpen: boolean;
  analyticsOpen: boolean;
  liveColumnsOpen: boolean;
  testRunnerOpen: boolean;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;
  designViewOpen: boolean;
  designsListOpen: boolean;
  allThreadsProjectId: string | null | undefined;
}

/**
 * Render-router for the main content area. Picks one of the 11 views based on
 * the active UI flag, defaulting to ThreadView. All views are lazy-loaded so
 * the chunk only ships when the user actually opens that view.
 *
 * Extracted from App.tsx as part of the god-file split: removes 11 lazy
 * imports from App's fan-out.
 */
export function MainContentSwitcher({
  generalSettingsOpen,
  settingsOpen,
  analyticsOpen,
  liveColumnsOpen,
  testRunnerOpen,
  automationInboxOpen,
  addProjectOpen,
  designViewOpen,
  designsListOpen,
  allThreadsProjectId,
}: MainContentSwitcherProps) {
  if (generalSettingsOpen) return <GeneralSettingsView />;
  if (settingsOpen) return <SettingsDetailView />;
  if (analyticsOpen) return <AnalyticsView />;
  if (liveColumnsOpen) return <LiveColumnsView />;
  if (testRunnerOpen) return <TestRunnerPane />;
  if (automationInboxOpen) return <AutomationInboxView />;
  if (addProjectOpen) return <AddProjectView />;
  if (designViewOpen) return <DesignView />;
  if (designsListOpen) return <DesignsListView />;
  if (allThreadsProjectId) return <AllThreadsView />;
  return <ThreadView />;
}
