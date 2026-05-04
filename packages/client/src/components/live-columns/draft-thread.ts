import { DEFAULT_THREAD_MODE } from '@funny/shared/models';

import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';

/**
 * Creates an idle (draft) thread for the given project. Used by the grid
 * header "+" button and by EmptyGridCell to make a new thread that the user
 * can immediately start typing into.
 */
export async function createDraftThread(
  projectId: string,
  defaultMode: 'local' | 'worktree' | undefined,
): Promise<string | null> {
  const result = await api.createIdleThread({
    projectId,
    title: 'New thread',
    mode: defaultMode || DEFAULT_THREAD_MODE,
  });
  if (result.isErr()) {
    toastError(result.error);
    return null;
  }
  return result.value.id;
}
