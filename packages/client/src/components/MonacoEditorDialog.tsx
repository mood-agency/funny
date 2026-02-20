import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Editor } from '@monaco-editor/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Loader2, Save, X, Maximize2, Minimize2, Eye, EyeOff } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';

interface MonacoEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
}

export function MonacoEditorDialog({ open, onOpenChange, filePath }: MonacoEditorDialogProps) {
  const { t } = useTranslation();
  const theme = useSettingsStore((s) => s.theme);
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isDirty = content !== originalContent;
  const ext = getFileExtension(filePath);
  const language = getMonacoLanguage(ext);

  // Derive Monaco theme from Funny theme
  const monacoTheme =
    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'vs-dark'
      : 'vs';

  // Load file content when dialog opens
  useEffect(() => {
    if (!open) return;

    setLoading(true);
    api.readFile(filePath).then((result) => {
      if (result.isOk()) {
        setContent(result.value.content);
        setOriginalContent(result.value.content);
      } else {
        toast.error(t('editor.failedToLoad', 'Failed to load file'), {
          description: result.error.message,
        });
        onOpenChange(false);
      }
      setLoading(false);
    });
  }, [open, filePath, onOpenChange, t]);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.writeFile(filePath, content);
    setSaving(false);

    if (result.isOk()) {
      setOriginalContent(content);
      toast.success(t('editor.saved', 'File saved'));
    } else {
      toast.error(t('editor.failedToSave', 'Failed to save file'), {
        description: result.error.message,
      });
    }
  };

  const handleClose = () => {
    if (isDirty) {
      const confirmed = confirm(
        t('editor.unsavedChanges', 'You have unsaved changes. Close without saving?')
      );
      if (!confirmed) return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={
          isFullscreen
            ? 'max-w-[100vw] max-h-[100vh] w-[100vw] h-[100vh] p-0'
            : 'max-w-5xl max-h-[85vh] h-[85vh] p-0'
        }
      >
        <DialogHeader className="px-6 pt-4 pb-2 border-b border-border/50">
          <div className="flex items-center justify-between">
            <DialogTitle className="font-mono text-sm truncate">{filePath}</DialogTitle>
            <div className="flex items-center gap-2">
              {/* Minimap toggle */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowMinimap(!showMinimap)}
                title={showMinimap ? t('editor.hideMinimap') : t('editor.showMinimap')}
                className="h-8 w-8"
              >
                {showMinimap ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>

              {/* Fullscreen toggle */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsFullscreen(!isFullscreen)}
                title={isFullscreen ? t('editor.exitFullscreen') : t('editor.fullscreen')}
                className="h-8 w-8"
              >
                {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Editor
              height="100%"
              language={language}
              theme={monacoTheme}
              value={content}
              onChange={(value) => setContent(value || '')}
              options={{
                minimap: { enabled: showMinimap },
                fontSize: 13,
                lineNumbers: 'on',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
              }}
            />
          )}
        </div>

        {/* Footer with save/cancel */}
        <div className="px-6 py-3 border-t border-border/50 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {isDirty && <span>{t('editor.modified', 'Modified')}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleClose}>
              <X className="h-3.5 w-3.5 mr-1" />
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!isDirty || saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Extract file extension from path
 */
function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash) {
    return filePath.substring(lastDot + 1);
  }
  return '';
}

/**
 * Map file extension to Monaco language identifier
 */
function getMonacoLanguage(ext: string): string {
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    md: 'markdown',
    mdx: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    dockerfile: 'dockerfile',
    php: 'php',
    vue: 'vue',
    graphql: 'graphql',
  };
  return langMap[ext.toLowerCase()] || 'plaintext';
}
