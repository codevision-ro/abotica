import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex h-[calc(100svh-3.5rem-1rem)] min-h-0 flex-col gap-4 p-4 md:p-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="min-h-0 flex-1 rounded-2xl" />
    </div>
  );
}
