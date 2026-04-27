import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';

import { Button } from '@/components/ui/button';

import { FollowUpModeDialog } from './FollowUpModeDialog';

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function FollowUpTrigger({ label }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" data-testid="followup-trigger" onClick={() => setOpen(true)}>
        {label ?? 'Open follow-up dialog'}
      </Button>
      <FollowUpModeDialog
        open={open}
        onInterrupt={() => setOpen(false)}
        onQueue={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/FollowUpModeDialog',
  component: FollowUpModeDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default state — three action options. */
export const Default: Story = {
  render: () => <FollowUpTrigger />,
};

/* ------------------------------------------------------------------ */
/*  Interaction tests                                                 */
/* ------------------------------------------------------------------ */

export const ClickInterrupt: Story = {
  render: () => <FollowUpTrigger />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    // Open the dialog first
    const trigger = canvas.getByTestId('followup-trigger');
    await userEvent.click(trigger);
    // Click interrupt
    const btn = canvas.getByTestId('followup-interrupt');
    await expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
  },
};

export const ClickQueue: Story = {
  render: () => <FollowUpTrigger />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByTestId('followup-trigger');
    await userEvent.click(trigger);
    const btn = canvas.getByTestId('followup-queue');
    await expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
  },
};

export const ClickCancel: Story = {
  render: () => <FollowUpTrigger />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByTestId('followup-trigger');
    await userEvent.click(trigger);
    const btn = canvas.getByTestId('followup-cancel');
    await expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
  },
};
