import { request } from './_core';

export const browseApi = {
  browseRoots: () => request<{ roots: string[]; home: string }>('/browse/roots'),
  browseList: (path: string) =>
    request<{
      path: string;
      parent: string | null;
      dirs: Array<{ name: string; path: string }>;
      error?: string;
    }>(`/browse/list?path=${encodeURIComponent(path)}`),
  openInEditor: (path: string, editor: string) =>
    request<{ ok: boolean }>('/browse/open-in-editor', {
      method: 'POST',
      body: JSON.stringify({ path, editor }),
    }),
  openDirectory: (path: string) =>
    request<{ ok: boolean }>('/browse/open-directory', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  openTerminal: (path: string) =>
    request<{ ok: boolean }>('/browse/open-terminal', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  repoName: (path: string) =>
    request<{ name: string }>(`/browse/repo-name?path=${encodeURIComponent(path)}`),
  remoteUrl: (path: string) =>
    request<{ url: string | null }>(`/browse/remote-url?path=${encodeURIComponent(path)}`),
  gitInit: (path: string) =>
    request<{ ok: boolean }>('/browse/git-init', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createDirectory: (parent: string, name: string) =>
    request<{ ok: boolean; path: string }>('/browse/create-directory', {
      method: 'POST',
      body: JSON.stringify({ parent, name }),
    }),
  browseFiles: (path: string, query?: string, limit?: number) => {
    const params = new URLSearchParams({ path });
    if (query) params.set('query', query);
    if (limit) params.set('limit', String(limit));
    return request<{
      files: Array<{ path: string; type: 'file' | 'folder' } | string>;
      truncated: boolean;
    }>(`/browse/files?${params.toString()}`);
  },
  /**
   * Fetch the full file index for a project. Returns the entire list of
   * tracked files and a monotonic `version`. Pass `since` to get a no-op
   * `{ unchanged: true }` response when the server-side index is unchanged.
   */
  getFileIndex: (path: string, since?: number) => {
    const params = new URLSearchParams({ path });
    if (since && since > 0) params.set('since', String(since));
    return request<{ files: string[]; version: number } | { unchanged: true; version: number }>(
      `/browse/files/index?${params.toString()}`,
    );
  },
  searchSymbols: (path: string, query?: string, file?: string) => {
    const params = new URLSearchParams({ path });
    if (query) params.set('query', query);
    if (file) params.set('file', file);
    return request<{
      symbols: Array<{
        name: string;
        kind: string;
        filePath: string;
        line: number;
        endLine?: number;
        containerName?: string;
      }>;
      truncated: boolean;
      indexed: boolean;
    }>(`/browse/symbols?${params.toString()}`);
  },
  triggerSymbolIndex: (path: string) =>
    request<{ ok: boolean }>('/browse/symbols/index', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
};
