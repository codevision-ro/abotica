import { cn } from "@/lib/utils";

/**
 * Title of a settings page, next to the settings nav; `actions` holds the page's primary action. With an
 * `id`, it heads a part further down a page instead (Memory on Agents), and links can jump to it.
 */
export function SectionHeader({
  id,
  title,
  description,
  actions,
}: {
  id?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        id && "scroll-mt-20 pt-4",
      )}
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg leading-snug font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
