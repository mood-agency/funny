export interface ReferencedItem {
  path: string;
  type: 'file' | 'folder';
}

/**
 * Parses `<referenced-files>` XML from the beginning of user message content.
 * Returns the extracted file/folder paths and the clean message text without the XML block.
 */
export function parseReferencedFiles(content: string): {
  files: ReferencedItem[];
  cleanContent: string;
} {
  const match = content.match(/^\s*<referenced-files>\s*([\s\S]*?)\s*<\/referenced-files>\s*/);
  if (!match) return { files: [], cleanContent: content };

  const xmlBlock = match[0];
  const inner = match[1];

  const items: ReferencedItem[] = [];

  // Extract folder paths from <folder path="..."> tags (don't expand their children)
  const folderRegex = /<folder\s+path="([^"]+)"[^>]*>[\s\S]*?<\/folder>/g;
  const folderRanges: [number, number][] = [];
  let folderMatch: RegExpExecArray | null;
  while ((folderMatch = folderRegex.exec(inner)) !== null) {
    items.push({ path: folderMatch[1], type: 'folder' });
    folderRanges.push([folderMatch.index, folderMatch.index + folderMatch[0].length]);
  }

  // Extract file paths from <file path="..."> tags that are NOT inside a <folder> block
  const fileRegex = /<file\s+path="([^"]+)"[^>]*>/g;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileRegex.exec(inner)) !== null) {
    const pos = fileMatch.index;
    const insideFolder = folderRanges.some(([start, end]) => pos >= start && pos < end);
    if (!insideFolder) {
      items.push({ path: fileMatch[1], type: 'file' });
    }
  }

  // Remove @path mentions from the visible text since they're shown as chips
  let cleanContent = content.slice(xmlBlock.length);
  for (const item of items) {
    // Escape special regex chars in the path, then strip @path (with optional trailing space)
    const escaped = item.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleanContent = cleanContent.replace(new RegExp(`@${escaped}\\s?`, 'g'), '');
  }
  return { files: items, cleanContent };
}
