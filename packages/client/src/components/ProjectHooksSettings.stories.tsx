import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { useAppStore } from '@/stores/app-store';

import { ProjectHooksSettings } from './ProjectHooksSettings';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="max-w-4xl p-6">{children}</div>
    </MemoryRouter>
  );
}

const meta = {
  title: 'Settings/ProjectHooksSettings',
  component: ProjectHooksSettings,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProjectHooksSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default view — project selected, hooks loaded from API. */
export const Default: Story = {
  render: () => {
    useAppStore.setState({ selectedProjectId: 'proj-1' });
    return (
      <Wrapper>
        <ProjectHooksSettings />
      </Wrapper>
    );
  },
};

/** No project selected — shows empty message. */
export const NoProject: Story = {
  render: () => {
    useAppStore.setState({ selectedProjectId: null });
    return (
      <Wrapper>
        <ProjectHooksSettings />
      </Wrapper>
    );
  },
};
