import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';

import { CircuitBreakerDialog } from './CircuitBreakerDialog';

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function CircuitBreakerTrigger({ state }: { state: 'open' | 'half-open' }) {
  // Reset to closed on mount so the overlay isn't visible until the user clicks.
  useEffect(() => {
    useCircuitBreakerStore.setState({ state: 'closed', failureCount: 0 });
  }, []);

  return (
    <>
      <Button
        variant="outline"
        data-testid="circuit-breaker-trigger"
        onClick={() => useCircuitBreakerStore.setState({ state, failureCount: 3 })}
      >
        Trigger circuit breaker ({state})
      </Button>
      <CircuitBreakerDialog />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta = {
  title: 'Dialogs/CircuitBreakerDialog',
  component: CircuitBreakerTrigger,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof CircuitBreakerTrigger>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Circuit open — shows error screen with retry button. */
export const Open: Story = {
  args: { state: 'open' },
};

/** Half-open — reconnection attempt in progress (no retry button). */
export const HalfOpen: Story = {
  args: { state: 'half-open' },
};
