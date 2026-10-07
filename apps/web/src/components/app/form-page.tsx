import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { SummaryRail } from "./summary-rail";
import { UnsavedChangesGuard } from "./unsaved-changes-guard";

/**
 * Columns of the long create/edit forms: the sections, then the summary rail from lg. This module has no
 * "use client" so the loading skeleton (a server component) can read it; `FormPage` renders inside client forms.
 */
export const formPageGridClass =
  "grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]";

const barClass = (layout: string) =>
  `sticky bottom-0 z-10 -mx-4 flex ${layout} gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 lg:hidden`;

/** Who or what the form is about, at the top of the rail and in the bottom bar. */
type FormPageIdentity = {
  /** Trimmed; while empty, `untitled` shows in muted text. */
  name: string;
  untitled?: string;
  /** Second line in the rail; nothing when empty. */
  subtitle?: React.ReactNode;
  subtitleClassName?: string;
  /** Avatar or icon tile: "xl" in the rail, "md" in the bottom bar. */
  media?: (size: "xl" | "md") => React.ReactNode;
};

/**
 * Layout of the long create/edit forms (agent, project, MCP server, skill): the sections on the left, a
 * sticky summary rail with the actions on the right from lg, and a sticky bottom bar below lg.
 * Also asks before leaving with unsaved changes.
 */
export function FormPage({
  as = "form",
  guard,
  identity,
  identityInRail = true,
  summary,
  alert,
  versionNote,
  submit,
  cancel,
  status,
  children,
  ...formProps
}: Omit<React.ComponentProps<"form">, "children"> & {
  /** "div" when the form element sits inside the sections, e.g. with content after it that is not part of it. */
  as?: "form" | "div";
  /** Unsaved changes that a navigation would lose. */
  guard: boolean;
  identity: FormPageIdentity;
  /** False where the page header already names the item. */
  identityInRail?: boolean;
  /** The rail's `SummaryList`. */
  summary: React.ReactNode;
  /** Form-level error above the actions; when given, the bottom bar stacks it over its row. */
  alert?: React.ReactNode;
  /** Optional note saved with the new version; replaces the name in the bottom bar. */
  versionNote?: { value: string; onChange: (value: string) => void; placeholder: string; label: string };
  submit: (className?: string) => React.ReactNode;
  cancel?: React.ReactNode;
  /** One line under the actions, e.g. whether there are unsaved changes. */
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { name, untitled, subtitle, subtitleClassName, media } = identity;
  const note = (className?: string) =>
    versionNote && (
      <Input
        value={versionNote.value}
        onChange={(e) => versionNote.onChange(e.target.value)}
        placeholder={versionNote.placeholder}
        aria-label={versionNote.label}
        maxLength={300}
        className={className}
      />
    );
  const lines = (
    <>
      <p className={cn("truncate font-semibold", !name && "text-muted-foreground")}>{name || untitled}</p>
      {subtitle && <p className={cn("truncate text-sm text-muted-foreground", subtitleClassName)}>{subtitle}</p>}
    </>
  );
  const barName = media ? (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {media("md")}
      <span className={cn("truncate text-sm font-medium", !name && "text-muted-foreground")}>{name || untitled}</span>
    </div>
  ) : (
    <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", !name && "text-muted-foreground")}>
      {name || untitled}
    </span>
  );
  const barRow = (
    <>
      {versionNote ? note("min-w-0 flex-1") : barName}
      {cancel}
      {submit()}
    </>
  );

  const content = (
    <>
      <UnsavedChangesGuard dirty={guard} />

      <div className="flex min-w-0 flex-col gap-5">{children}</div>

      <aside className="hidden lg:block">
        <SummaryRail className="sticky top-20 max-h-[calc(100svh-6rem)] overflow-y-auto">
          {identityInRail && (
            <>
              {media ? (
                <div className="flex min-w-0 items-center gap-3">
                  {media("xl")}
                  <div className="min-w-0 flex-1">{lines}</div>
                </div>
              ) : (
                <div className="min-w-0">{lines}</div>
              )}
              <Separator />
            </>
          )}
          {summary}
          <Separator />
          <div className="flex flex-col gap-2">
            {alert}
            {note()}
            {submit("w-full")}
            {cancel}
            {status !== undefined && (
              <p className="text-center text-xs text-muted-foreground" aria-live="polite">
                {status}
              </p>
            )}
          </div>
        </SummaryRail>
      </aside>

      {alert !== undefined ? (
        <div className={barClass("flex-col")}>
          {alert}
          <div className="flex items-center gap-2">{barRow}</div>
        </div>
      ) : (
        <div className={barClass("items-center")}>{barRow}</div>
      )}
    </>
  );

  return as === "div" ? (
    <div className={formPageGridClass}>{content}</div>
  ) : (
    <form className={formPageGridClass} {...formProps}>
      {content}
    </form>
  );
}
