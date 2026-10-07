import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h1
          title={typeof title === "string" ? title : undefined}
          className="line-clamp-2 text-2xl leading-tight font-semibold tracking-tight [overflow-wrap:anywhere] sm:line-clamp-1"
        >
          {title}
        </h1>
        {description && (
          <div className="max-w-3xl text-sm text-pretty text-muted-foreground [overflow-wrap:anywhere]">{description}</div>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Standard page body: max width, padding and vertical rhythm. Sticky form bars bleed out with `-mx-4 md:-mx-6`, so keep the padding in sync. */
export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-6", className)}>{children}</div>;
}
