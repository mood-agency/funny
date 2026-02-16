import { Skeleton } from '@/components/ui/skeleton';

/**
 * Renders a skeleton that mirrors the real app layout (sidebar + main area).
 * Shown immediately while auth/data loads — no network dependencies.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar skeleton */}
      <div className="w-80 border-r border-sidebar-border bg-sidebar flex flex-col">
        {/* Header — logo + action buttons */}
        <div className="px-4 py-3 flex items-center justify-between">
          <Skeleton className="h-5 w-24" />
          <div className="flex gap-1">
            <Skeleton className="h-7 w-7 rounded-md" />
            <Skeleton className="h-7 w-7 rounded-md" />
          </div>
        </div>

        {/* "Threads" section */}
        <div className="px-4 pt-3 pb-2">
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="px-2 space-y-1">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-full rounded-md" />
        </div>

        {/* "Projects" section */}
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-5 rounded" />
        </div>
        <div className="flex-1 px-2 space-y-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-7 w-full rounded-md" />
              <div className="pl-6 space-y-1">
                <Skeleton className="h-6 w-4/5 rounded-md" />
                <Skeleton className="h-6 w-3/5 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main content skeleton */}
      <div className="flex-1 flex flex-col bg-background">
        {/* Thread header */}
        <div className="border-b border-border px-4 py-3 flex items-center gap-3">
          <Skeleton className="h-5 w-48" />
        </div>
        {/* Message area */}
        <div className="flex-1 p-4 space-y-4">
          <Skeleton className="h-14 w-3/4 rounded-lg" />
          <Skeleton className="h-10 w-1/2 rounded-lg" />
          <Skeleton className="h-14 w-2/3 rounded-lg" />
        </div>
        {/* Input area */}
        <div className="border-t border-border p-4">
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
