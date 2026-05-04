import { type ReactNode, useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { colorFromName } from '@/components/ui/project-chip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { useProjectStore } from '@/stores/project-store';

interface Props {
  trigger: ReactNode;
  onSelect: (projectId: string) => void;
  placeholder: string;
}

/**
 * Popover with a project search list. Used by the grid header "+" button and
 * by EmptyGridCell to pick which project a new draft thread should belong
 * to. Extracted from LiveColumnsView so the parent doesn't import the
 * Popover/ScrollArea/SearchBar/project-chip cluster.
 */
export function ProjectPickerPopover({ trigger, onSelect, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const projects = useProjectStore((s) => s.projects);
  const filtered = search
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch('');
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b border-border/50 px-2 py-1.5">
          <SearchBar
            query={search}
            onQueryChange={setSearch}
            placeholder={placeholder}
            totalMatches={filtered.length}
            resultLabel={search ? `${filtered.length}/${projects.length}` : ''}
            autoFocus
            testIdPrefix="grid-project-picker-search"
          />
        </div>
        <ScrollArea className="max-h-56 py-1">
          {filtered.length === 0 ? (
            <div className="py-3 text-center text-sm text-muted-foreground">—</div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                data-testid={`grid-project-pick-${p.id}`}
                onClick={() => {
                  setOpen(false);
                  setSearch('');
                  onSelect(p.id);
                }}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color || colorFromName(p.name) }}
                />
                <span className="truncate">{p.name}</span>
              </button>
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
