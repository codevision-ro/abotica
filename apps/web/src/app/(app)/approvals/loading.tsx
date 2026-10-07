import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the approvals page: header, tabs and the pending request cards. */
export default function Loading() {
  return (
    <PageBody>
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-9 w-56" />
      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={sectionCardClass}>
            <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3.5 w-64 max-w-full" />
              </div>
            </div>
            <div className="space-y-3 border-t border-border/60 p-4 sm:p-5">
              <Skeleton className="h-20 rounded-xl" />
              <div className="flex justify-end gap-2">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </PageBody>
  );
}
