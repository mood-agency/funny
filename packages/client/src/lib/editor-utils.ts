import { useSettingsStore, editorLabels } from '@/stores/settings-store';
import type { Editor } from '@/stores/settings-store';
import { api } from '@/lib/api';

/**
 * URI protocol schemes for each supported editor.
 * Editors without a URI scheme (sublime, vim, internal) return null — use the server API fallback or internal editor.
 */
const EDITOR_URI_SCHEMES: Record<Editor, string | null> = {
  vscode: 'vscode',
  cursor: 'cursor',
  windsurf: 'windsurf',
  zed: 'zed',
  sublime: null,
  vim: null,
  internal: null,
};

/** Returns true if the editor supports a `scheme://file/...` URI protocol. */
export function hasEditorUri(editor?: Editor): boolean {
  const e = editor ?? useSettingsStore.getState().defaultEditor;
  return EDITOR_URI_SCHEMES[e] != null;
}

/**
 * Generate an editor URI for the given file path.
 * Returns `null` for editors without a URI scheme (sublime, vim).
 */
export function toEditorUri(filePath: string, editor?: Editor): string | null {
  const e = editor ?? useSettingsStore.getState().defaultEditor;
  const scheme = EDITOR_URI_SCHEMES[e];
  if (!scheme) return null;

  const normalized = filePath.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return `${scheme}://file${withLeadingSlash}`;
}

/**
 * Like `toEditorUri` but also handles `path:line` patterns
 * (e.g. `/src/file.ts:42`), appending `:line` to the URI.
 */
export function toEditorUriWithLine(filePath: string, editor?: Editor): string | null {
  const e = editor ?? useSettingsStore.getState().defaultEditor;
  const scheme = EDITOR_URI_SCHEMES[e];
  if (!scheme) return null;

  const match = filePath.match(/^(.+):(\d+)$/);
  const path = match ? match[1] : filePath;
  const line = match ? match[2] : null;

  const normalized = path.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return `${scheme}://file${withLeadingSlash}${line ? ':' + line : ''}`;
}

/** Returns the human-readable label for the given (or default) editor. */
export function getEditorLabel(editor?: Editor): string {
  const e = editor ?? useSettingsStore.getState().defaultEditor;
  return editorLabels[e];
}

/**
 * Open a file in the user's default (or specified) editor.
 * For URI-capable editors, navigates via the protocol URI.
 * For 'internal' editor, opens the Monaco editor dialog.
 * For others, calls the server API which spawns the editor CLI.
 */
export function openFileInEditor(filePath: string, editor?: Editor): void {
  const e = editor ?? useSettingsStore.getState().defaultEditor;

  // Handle internal editor separately
  if (e === 'internal') {
    // Dynamic import to avoid circular dependencies
    import('@/stores/internal-editor-store').then(({ useInternalEditorStore }) => {
      useInternalEditorStore.getState().openFile(filePath);
    });
    return;
  }

  // Handle URI-capable editors
  const uri = toEditorUri(filePath, e);
  if (uri) {
    window.location.href = uri;
  } else {
    // Fallback to server API for vim/sublime
    api.openInEditor(filePath, e);
  }
}
