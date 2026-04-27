import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import { SaveBacklogDialog } from '@/components/thread/SaveBacklogDialog';
import { Button } from '@/components/ui/button';

interface TriggerProps {
  loading?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

function SaveBacklogTrigger(args: TriggerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" data-testid="save-backlog-trigger" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <SaveBacklogDialog
        open={open}
        loading={args.loading}
        onSave={() => {
          setOpen(false);
          args.onSave();
        }}
        onDiscard={() => {
          setOpen(false);
          args.onDiscard();
        }}
        onCancel={() => {
          setOpen(false);
          args.onCancel();
        }}
      />
    </>
  );
}

const meta: Meta<typeof SaveBacklogTrigger> = {
  title: 'Dialogs/SaveBacklogDialog',
  component: SaveBacklogTrigger,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    loading: false,
    onSave: fn(),
    onDiscard: fn(),
    onCancel: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

/** Default unsaved prompt dialog shown when leaving a thread with a draft. */
export const Default: Story = {};

/** Save button in loading state while persisting the backlog item. */
export const Loading: Story = {
  args: { loading: true },
};

export const ClickSave: Story = {
  play: async ({ args, canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByTestId('save-backlog-trigger'));
    await userEvent.click(canvas.getByTestId('save-backlog-save'));
    await expect(args.onSave).toHaveBeenCalledTimes(1);
    await expect(args.onDiscard).not.toHaveBeenCalled();
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};

export const ClickDiscard: Story = {
  play: async ({ args, canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByTestId('save-backlog-trigger'));
    await userEvent.click(canvas.getByTestId('save-backlog-discard'));
    await expect(args.onDiscard).toHaveBeenCalledTimes(1);
    await expect(args.onSave).not.toHaveBeenCalled();
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};

export const ClickCancel: Story = {
  play: async ({ args, canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByTestId('save-backlog-trigger'));
    await userEvent.click(canvas.getByTestId('save-backlog-cancel'));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await expect(args.onSave).not.toHaveBeenCalled();
    await expect(args.onDiscard).not.toHaveBeenCalled();
  },
};
