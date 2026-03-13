/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';

const MAX_FILE_SIZE = 100 * 1024; // 100KB per file
const MAX_TOTAL_CONTENT = 500 * 1024; // 500KB total
const MAX_FOLDER_FILES = 50; // max files to inline from a folder

export interface FileRef {
  path: string;
}

async function inlineFile(
  fullPath: string,
  relPath: string,
  totalSize: { value: number },
): Promise<string> {
  try {
    const fileStat = await stat(fullPath);
    const size = fileStat.size;

    if (size > MAX_FILE_SIZE || totalSize.value + size > MAX_TOTAL_CONTENT) {
      return `<file path="${relPath}" note="File too large to inline (${Math.round(size / 1024)}KB). Use the Read tool to access it."></file>`;
    }
    const content = await readFile(fullPath, 'utf-8');
    totalSize.value += size;
    return `<file path="${relPath}">\n${content}\n</file>`;
  } catch {
    return `<file path="${relPath}" note="File not found or unreadable"></file>`;
  }
}

export async function augmentPromptWithFiles(
  prompt: string,
  fileReferences: FileRef[] | undefined,
  basePath: string,
): Promise<string> {
  if (!fileReferences || fileReferences.length === 0) return prompt;

  const sections: string[] = [];
  const totalSize = { value: 0 };
  const resolvedBase = resolve(basePath);

  for (const ref of fileReferences) {
    const fullPath = join(basePath, ref.path);
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(resolvedBase)) continue;

    try {
      const fileStat = await stat(fullPath);

      if (fileStat.isDirectory()) {
        // Folder reference: list and inline files from the directory
        const entries = await readdir(fullPath, { withFileTypes: true });
        const files = entries.filter((e) => e.isFile()).map((e) => e.name);
        const truncated = files.length > MAX_FOLDER_FILES;
        const filesToInline = files.slice(0, MAX_FOLDER_FILES);

        const folderSections: string[] = [];
        for (const fileName of filesToInline) {
          if (totalSize.value >= MAX_TOTAL_CONTENT) break;
          const childPath = join(ref.path, fileName);
          const childFullPath = join(fullPath, fileName);
          folderSections.push(await inlineFile(childFullPath, childPath, totalSize));
        }

        const truncNote = truncated
          ? ` note="Showing ${MAX_FOLDER_FILES} of ${files.length} files. Use the Glob/Read tools to access more."`
          : '';
        sections.push(
          `<folder path="${ref.path}"${truncNote}>\n${folderSections.join('\n')}\n</folder>`,
        );
      } else {
        sections.push(await inlineFile(fullPath, ref.path, totalSize));
      }
    } catch {
      sections.push(`<file path="${ref.path}" note="File not found or unreadable"></file>`);
    }
  }

  if (sections.length === 0) return prompt;

  const fileContext = `<referenced-files>\n${sections.join('\n')}\n</referenced-files>\n\n`;
  return fileContext + prompt;
}
