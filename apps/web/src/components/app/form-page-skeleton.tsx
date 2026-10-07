import { formPageGridClass } from "@/components/app/form-page";
import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Loading state of the long create/edit forms (agent, project, MCP server, skill): back link,
 * the hero block, section cards and the summary rail.
 */
export function FormPageSkeleton({
  avatar = true,
  chips = false,
  sections = ["h-56", "h-24", "h-40"],
}: {
  /** Whether the hero has an icon/avatar tile next to the title. */
  avatar?: boolean;
  /** A row of start-from chips above the hero, as on the new agent page. */
  chips?: boolean;
  /** Content height of each section card, top to bottom. */
  sections?: string[];
}) {
  return (
    <PageBody>
      <Skeleton className="-mb-2 h-7 w-20" />
      {chips && (
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-4 w-16" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      )}
      <div className={formPageGridClass}>
        <div className="flex min-w-0 flex-col gap-5">
          <div className="mb-2 flex items-center gap-4 sm:gap-5">
            {avatar && <Skeleton className="size-16 shrink-0 rounded-2xl sm:size-20 sm:rounded-[1.25rem]" />}
            <div className="min-w-0 flex-1 space-y-2.5">
              <Skeleton className="h-8 w-64 max-w-full" />
              <Skeleton className="h-5 w-96 max-w-full" />
            </div>
          </div>
          {sections.map((height, i) => (
            <div key={i} className={sectionCardClass}>
              <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3.5 w-72 max-w-full" />
                </div>
              </div>
              <div className="border-t border-border/60 p-4 sm:p-5">
                <Skeleton className={cn(height, "rounded-xl")} />
              </div>
            </div>
          ))}
        </div>
        <div className="hidden lg:block">
          <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
            <div className="flex items-center gap-3">
              {avatar && <Skeleton className="size-12 rounded-xl" />}
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-24" />
              </div>
            </div>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </div>
    </PageBody>
  );
}
