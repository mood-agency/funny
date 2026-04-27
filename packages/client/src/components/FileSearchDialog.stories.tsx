import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync } from 'neverthrow';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { FileSearchDialog } from './FileSearchDialog';

/* ------------------------------------------------------------------ */
/*  Mock data                                                         */
/* ------------------------------------------------------------------ */

const MOCK_FILES = [
  { path: 'src/index.ts', type: 'file' as const },
  { path: 'src/components/Sidebar.tsx', type: 'file' as const },
  { path: 'src/components/ThreadView.tsx', type: 'file' as const },
  { path: 'src/hooks/use-ws.ts', type: 'file' as const },
  { path: 'src/stores/app-store.ts', type: 'file' as const },
  { path: 'src/lib/utils.ts', type: 'file' as const },
  { path: 'package.json', type: 'file' as const },
  { path: 'tsconfig.json', type: 'file' as const },
  { path: 'vite.config.ts', type: 'file' as const },
  { path: 'README.md', type: 'file' as const },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function setupStores() {
  useProjectStore.setState({
    selectedProjectId: 'proj-1',
    projects: [
      {
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/project',
        userId: 'u1',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ] as any,
  });
  useThreadStore.setState({ activeThread: null } as any);
}

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function FileSearchTrigger({ label, setupMocks }: { label: string; setupMocks: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="file-search-trigger"
        onClick={() => {
          setupMocks();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <FileSearchDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/FileSearchDialog',
  component: FileSearchDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default — file list loaded. */
export const Default: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search files"
      setupMocks={() => {
        setupStores();
        api.browseFiles = () => okAsync({ files: MOCK_FILES, truncated: false });
      }}
    />
  ),
};

/** Truncated results — shows "refine your search" hint. */
export const Truncated: Story = {
  render: () => {
    const manyFiles = Array.from({ length: 100 }, (_, i) => ({
      path: `src/components/Component${i}.tsx`,
      type: 'file' as const,
    }));
    return (
      <FileSearchTrigger
        label="Search (truncated)"
        setupMocks={() => {
          setupStores();
          api.browseFiles = () => okAsync({ files: manyFiles, truncated: true });
        }}
      />
    );
  },
};

/** Empty results. */
export const NoResults: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search (no results)"
      setupMocks={() => {
        setupStores();
        api.browseFiles = () => okAsync({ files: [], truncated: false });
      }}
    />
  ),
};

/** Loading state — API never resolves. */
export const Loading: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search (loading)"
      setupMocks={() => {
        setupStores();
        api.browseFiles = () => new Promise(() => {}) as any;
      }}
    />
  ),
};
