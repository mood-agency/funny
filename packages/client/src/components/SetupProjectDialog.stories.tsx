import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { SetupProjectDialog } from './SetupProjectDialog';

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function SetupProjectTrigger({
  projectId,
  projectName,
  label,
}: {
  projectId: string;
  projectName: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" data-testid="setup-project-trigger" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <SetupProjectDialog
        projectId={projectId}
        projectName={projectName}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/SetupProjectDialog',
  component: SetupProjectDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default state — prompting user to select local directory. */
export const Default: Story = {
  render: () => (
    <SetupProjectTrigger projectId="proj-1" projectName="my-api-server" label="Set up project" />
  ),
};

/** Long project name. */
export const LongProjectName: Story = {
  render: () => (
    <SetupProjectTrigger
      projectId="proj-1"
      projectName="my-incredibly-long-project-name-that-should-still-look-good-in-the-dialog"
      label="Set up (long name)"
    />
  ),
};
