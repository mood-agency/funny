import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { SwitchBranchDialog } from './SwitchBranchDialog';

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function SwitchBranchTrigger({
  currentBranch,
  targetBranch,
  loading,
  label,
}: {
  currentBranch: string;
  targetBranch: string;
  loading?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" data-testid="switch-branch-trigger" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <SwitchBranchDialog
        open={open}
        onOpenChange={setOpen}
        currentBranch={currentBranch}
        targetBranch={targetBranch}
        loading={loading}
        onSwitch={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/SwitchBranchDialog',
  component: SwitchBranchDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default — choosing between stash and carry. */
export const Default: Story = {
  render: () => (
    <SwitchBranchTrigger currentBranch="feat/dark-mode" targetBranch="main" label="Switch branch" />
  ),
};

/** Long branch names get truncated. */
export const LongBranchNames: Story = {
  render: () => (
    <SwitchBranchTrigger
      currentBranch="feat/refactor-authentication-subsystem-oauth2-pkce-flow"
      targetBranch="release/v2.0.0-beta.1-with-migration-support"
      label="Switch (long names)"
    />
  ),
};

/** Switching in progress. */
export const Loading: Story = {
  render: () => (
    <SwitchBranchTrigger
      currentBranch="feat/dark-mode"
      targetBranch="main"
      loading
      label="Switch (loading)"
    />
  ),
};

/** Feature branch to feature branch. */
export const FeatureToFeature: Story = {
  render: () => (
    <SwitchBranchTrigger
      currentBranch="feat/add-notifications"
      targetBranch="feat/user-settings"
      label="Switch (feat → feat)"
    />
  ),
};
