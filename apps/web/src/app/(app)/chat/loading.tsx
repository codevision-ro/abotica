import { Skeleton } from "@/components/ui/skeleton";

/** The conversation pane while it loads; the conversation list comes from the chat layout. */
export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5 md:px-6 md:py-3">
        <Skeleton className="size-9 rounded-xl md:size-10" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-48" />
        </div>
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6 md:px-6">
        <Skeleton className="ml-auto h-12 w-2/3 rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-3/4" />
        </div>
        <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4 md:px-6">
        <Skeleton className="h-24 rounded-3xl" />
      </div>
    </div>
  );
}
