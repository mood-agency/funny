import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { CreateBranchDialog } from './CreateBranchDialog';

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function CreateBranchTrigger({
  sourceBranch,
  threadTitle,
  loading,
  label,
}: {
  sourceBranch?: string;
  threadTitle?: string;
  loading?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" data-testid="create-branch-trigger" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <CreateBranchDialog
        open={open}
        onOpenChange={setOpen}
        sourceBranch={sourceBranch}
        threadTitle={threadTitle}
        loading={loading}
        onCreate={() => setOpen(false)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/CreateBranchDialog',
  component: CreateBranchDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default — new branch will be based on `main`. */
export const Default: Story = {
  render: () => <CreateBranchTrigger sourceBranch="main" label="Create branch" />,
};

/** Source branch is a long feature branch. */
export const FromFeatureBranch: Story = {
  render: () => (
    <CreateBranchTrigger
      sourceBranch="feat/refactor-authentication-subsystem"
      label="Create branch (from feature)"
    />
  ),
};

/** Includes a thread title — Sparkles "Suggest from title" button is enabled. */
export const WithSuggestFromTitle: Story = {
  render: () => (
    <CreateBranchTrigger
      sourceBranch="master"
      threadTitle="Add dark mode toggle to settings"
      label="Create branch (with suggest)"
    />
  ),
};

/** No source branch known — falls back to "current branch" label. */
export const UnknownSourceBranch: Story = {
  render: () => <CreateBranchTrigger label="Create branch (unknown source)" />,
};

/** Creation in progress — confirm button shows spinner. */
export const Loading: Story = {
  render: () => <CreateBranchTrigger sourceBranch="main" loading label="Create (loading)" />,
};
