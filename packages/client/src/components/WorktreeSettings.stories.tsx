import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { useAppStore } from '@/stores/app-store';

import { WorktreeSettings } from './WorktreeSettings';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="max-w-4xl p-6">{children}</div>
    </MemoryRouter>
  );
}

const meta = {
  title: 'Settings/WorktreeSettings',
  component: WorktreeSettings,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof WorktreeSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default view with a project selected — worktrees loaded from API. */
export const Default: Story = {
  render: () => {
    useAppStore.setState({
      selectedProjectId: 'proj-1',
      projects: [
        {
          id: 'proj-1',
          name: 'funny',
          path: '/home/user/projects/funny',
          userId: 'user-1',
          sortOrder: 0,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    return (
      <Wrapper>
        <WorktreeSettings />
      </Wrapper>
    );
  },
};

/** No project selected — shows empty message. */
export const NoProject: Story = {
  render: () => {
    useAppStore.setState({ selectedProjectId: null, projects: [] });
    return (
      <Wrapper>
        <WorktreeSettings />
      </Wrapper>
    );
  },
};
