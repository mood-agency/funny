import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { useAppStore } from '@/stores/app-store';

import { ProjectConfigSettings } from './ProjectConfigSettings';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="max-w-4xl p-6">{children}</div>
    </MemoryRouter>
  );
}

const meta = {
  title: 'Settings/ProjectConfigSettings',
  component: ProjectConfigSettings,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProjectConfigSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default view with a project selected — config loaded from API. */
export const Default: Story = {
  render: () => {
    useAppStore.setState({ selectedProjectId: 'proj-1' });
    return (
      <Wrapper>
        <ProjectConfigSettings />
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
        <ProjectConfigSettings />
      </Wrapper>
    );
  },
};
