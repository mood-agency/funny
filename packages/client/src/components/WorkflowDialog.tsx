import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { GitBranch, Monitor, Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

const PIPELINE_AGENTS = [
  { value: 'tests', label: 'Tests' },
  { value: 'security', label: 'Security' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'performance', label: 'Performance' },
  { value: 'style', label: 'Style' },
  { value: 'types', label: 'Types' },
  { value: 'docs', label: 'Docs' },
] as const;

export function WorkflowDialog() {
  const { t } = useTranslation();
  const projectId = useUIStore((s) => s.workflowDialogProjectId);
  const projectPath = useUIStore((s) => s.workflowDialogProjectPath);
  const closeDialog = useUIStore((s) => s.closeWorkflowDialog);

  const [mode, setMode] = useState<'local' | 'worktree'>('local');
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [currentBranch, setCurrentBranch] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['tests', 'security', 'style']);
  const [loading, setLoading] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const branchSearchRef = useRef<HTMLInputElement>(null);

  const open = !!projectId;

  // Load branches when dialog opens
  useEffect(() => {
    if (!projectId) return;
    setBranchesLoading(true);
    api.listBranches(projectId).then((result) => {
      result.match(
        (data) => {
          setBranches(data.branches);
          setDefaultBranch(data.defaultBranch ?? 'main');
          setCurrentBranch(data.currentBranch ?? data.branches[0] ?? '');
          setSelectedBranch(data.currentBranch ?? data.branches[0] ?? '');
        },
        () => setBranches([]),
      );
      setBranchesLoading(false);
    });
  }, [projectId]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setMode('local');
      setBranches([]);
      setSelectedBranch('');
      setDefaultBranch('main');
      setCurrentBranch('');
      setSelectedAgents(['tests', 'security', 'style']);
      setBranchesLoading(false);
      setBranchSearch('');
      setBranchOpen(false);
    }
  }, [open]);

  const toggleAgent = (agent: string) => {
    setSelectedAgents((prev) =>
      prev.includes(agent) ? prev.filter((a) => a !== agent) : [...prev, agent],
    );
  };

  const handleRun = async () => {
    if (!projectId || !projectPath) return;
    if (mode === 'worktree' && !selectedBranch) return;
    if (selectedAgents.length === 0) return;

    setLoading(true);

    let worktreePath = projectPath;
    let branch = currentBranch;

    if (mode === 'worktree') {
      const timestamp = Date.now();
      const safeBranch = selectedBranch.replace(/\//g, '-');
      const branchName = `pipeline/${safeBranch}-${timestamp}`;
      const wtResult = await api.createWorktree({
        projectId,
        branchName,
        baseBranch: selectedBranch,
      });

      if (wtResult.isErr()) {
        toast.error('Failed to create worktree', {
          description: wtResult.error.message,
        });
        setLoading(false);
        return;
      }

      worktreePath = wtResult.value.path;
      branch = selectedBranch; // Send the source branch, not the pipeline/ worktree branch
    }

    const result = await api.runPipeline({
      branch,
      worktree_path: worktreePath,
      base_branch: defaultBranch,
      config: selectedAgents.length > 0 ? { agents: selectedAgents } : undefined,
      metadata: { projectId },
    });

    setLoading(false);

    if (result.isOk()) {
      toast.success(`Pipeline started${mode === 'worktree' ? ` on ${selectedBranch}` : ''}`, {
        description: `Analyzing against ${defaultBranch}`,
      });
      closeDialog();
    } else {
      const errMsg = typeof result.error.message === 'string'
        ? result.error.message
        : JSON.stringify(result.error.message);
      toast.error('Failed to start pipeline', { description: errMsg });
    }
  };

  const filteredBranches = branches.filter(
    (b) => !branchSearch || b.toLowerCase().includes(branchSearch.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeDialog(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Run Quality Pipeline</DialogTitle>
          <DialogDescription>
            Run quality agents on your code to check tests, security, style, and more.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Mode selector */}
          <div className="flex gap-2">
            <button
              onClick={() => setMode('local')}
              aria-pressed={mode === 'local'}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                mode === 'local'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-accent/50',
              )}
            >
              <Monitor className="h-4 w-4" />
              Local
            </button>
            <button
              onClick={() => setMode('worktree')}
              aria-pressed={mode === 'worktree'}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                mode === 'worktree'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-accent/50',
              )}
            >
              <GitBranch className="h-4 w-4" />
              Worktree
            </button>
          </div>

          {/* Local mode info */}
          {mode === 'local' && currentBranch && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <p className="text-sm text-muted-foreground">
                Will analyze current working state on{' '}
                <span className="font-mono text-foreground">{currentBranch}</span>
                {defaultBranch && defaultBranch !== currentBranch && (
                  <> against <span className="font-mono text-foreground">{defaultBranch}</span></>
                )}
              </p>
            </div>
          )}

          {/* Branch selector (worktree mode) */}
          {mode === 'worktree' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Branch to analyze
              </label>
              <Popover open={branchOpen} onOpenChange={(v) => { setBranchOpen(v); if (!v) setBranchSearch(''); }}>
                <PopoverTrigger asChild>
                  <button
                    className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 h-9 text-sm transition-[border-color,box-shadow] duration-150 hover:bg-accent/50 focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{selectedBranch || 'Select branch...'}</span>
                    </div>
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[var(--radix-popover-trigger-width)] p-0 flex flex-col"
                  style={{ maxHeight: '320px' }}
                  align="start"
                  onOpenAutoFocus={(e) => { e.preventDefault(); branchSearchRef.current?.focus(); }}
                >
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      ref={branchSearchRef}
                      type="text"
                      value={branchSearch}
                      onChange={(e) => setBranchSearch(e.target.value)}
                      placeholder="Search branches..."
                      autoComplete="off"
                      className="w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
                    />
                  </div>
                  <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: '260px' }}>
                    <div className="p-1">
                      {filteredBranches.map((b) => {
                        const isSelected = b === selectedBranch;
                        return (
                          <button
                            key={b}
                            onClick={() => { setSelectedBranch(b); setBranchOpen(false); setBranchSearch(''); }}
                            className={cn(
                              'w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                              isSelected
                                ? 'bg-accent text-foreground'
                                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                            )}
                          >
                            <GitBranch className="h-3.5 w-3.5 shrink-0 text-status-info" />
                            <span className="font-mono truncate">{b}</span>
                            {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-status-info ml-auto" />}
                          </button>
                        );
                      })}
                      {filteredBranches.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-3">
                          No branches match
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                </PopoverContent>
              </Popover>
              {defaultBranch && selectedBranch && defaultBranch !== selectedBranch && (
                <p className="text-xs text-muted-foreground mt-1">
                  Comparing against <span className="font-mono">{defaultBranch}</span>
                </p>
              )}
            </div>
          )}

          {/* Agent selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Quality agents</label>
            <div className="flex flex-wrap gap-1.5">
              {PIPELINE_AGENTS.map((agent) => (
                <button
                  key={agent.value}
                  type="button"
                  onClick={() => toggleAgent(agent.value)}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-md border transition-colors',
                    selectedAgents.includes(agent.value)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
                  )}
                >
                  {agent.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeDialog}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleRun}
            disabled={branchesLoading || selectedAgents.length === 0 || (mode === 'local' && !currentBranch) || (mode === 'worktree' && !selectedBranch)}
            loading={loading}
          >
            Run Pipeline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
