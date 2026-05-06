import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync } from 'neverthrow';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useFileIndexStore } from '@/stores/file-index-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { FileSearchDialog } from './FileSearchDialog';

/* ------------------------------------------------------------------ */
/*  Mock data                                                         */
/* ------------------------------------------------------------------ */

const MOCK_FILES = [
  'src/index.ts',
  'src/components/Sidebar.tsx',
  'src/components/ThreadView.tsx',
  'src/hooks/use-ws.ts',
  'src/stores/app-store.ts',
  'src/lib/utils.ts',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'README.md',
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

function seedIndex(basePath: string, files: string[]) {
  useFileIndexStore.setState({
    byPath: { [basePath]: { files, version: 1, stale: false } },
    inflight: {},
  });
}

/** Default — file list loaded. */
export const Default: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search files"
      setupMocks={() => {
        setupStores();
        seedIndex('/home/user/project', MOCK_FILES);
        api.getFileIndex = () => okAsync({ files: MOCK_FILES, version: 1 });
      }}
    />
  ),
};

/** Truncated results — shows "refine your search" hint. */
export const Truncated: Story = {
  render: () => {
    const manyFiles = Array.from({ length: 500 }, (_, i) => `src/components/Component${i}.tsx`);
    return (
      <FileSearchTrigger
        label="Search (truncated)"
        setupMocks={() => {
          setupStores();
          seedIndex('/home/user/project', manyFiles);
          api.getFileIndex = () => okAsync({ files: manyFiles, version: 1 });
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
        seedIndex('/home/user/project', []);
        api.getFileIndex = () => okAsync({ files: [], version: 1 });
      }}
    />
  ),
};

/** Loading state — index fetch never resolves. */
export const Loading: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search (loading)"
      setupMocks={() => {
        setupStores();
        useFileIndexStore.setState({ byPath: {}, inflight: {} });
        api.getFileIndex = () => new Promise(() => {}) as any;
      }}
    />
  ),
};
