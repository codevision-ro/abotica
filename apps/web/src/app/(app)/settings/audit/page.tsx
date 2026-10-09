import { auditActionKey } from "@abotica/core/audit-actions";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SectionEmpty, sectionCardClass } from "@/components/app/section-card";
import { AuditFilters } from "@/components/settings/audit-filters";
import { AuditSettingsChanges } from "@/components/settings/audit-settings-changes";
import { SectionHeader } from "@/components/settings/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import { AUDIT_PAGE_SIZE, getAuditLogPage } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("audit") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function AuditPage(props: PageProps<"/settings/audit">) {
  const sp = await props.searchParams;
  const actor = one(sp.actor);
  const entityType = one(sp.entity);
  const page = Math.max(1, Number.parseInt(one(sp.page) ?? "1", 10) || 1);
  const [{ rows, total, actors, entityTypes }, t, fmt] = await Promise.all([
    getAuditLogPage({ actor, entityType, page }),
    getTranslations("settings.audit"),
    getFormat(),
  ]);
  /** Readable label for a dynamic value, or null when there is no message for it. */
  const label = (group: "actions" | "actors" | "entities" | "domains", value: string) => {
    const key = `${group}.${group === "actions" ? auditActionKey(value) : value}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : null;
  };
  const actorOptions = actors.map((value) => ({ value, label: label("actors", value) ?? value }));
  const entityOptions = entityTypes.map((value) => ({ value, label: label("entities", value) ?? value }));
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  const href = (p: number) => {
    const params = new URLSearchParams();
    if (actor) params.set("actor", actor);
    if (entityType) params.set("entity", entityType);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/settings/audit?${qs}` : "/settings/audit";
  };
  // A page past the end (stale link, fewer rows after filtering) would read as an empty log.
  if (page > pages) redirect(href(pages));

  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <section aria-label={t("title")} className={cn(sectionCardClass, "overflow-hidden")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
          <AuditFilters actors={actorOptions} entityTypes={entityOptions} actor={actor} entityType={entityType} />
          <span className="tabular ml-auto text-sm text-muted-foreground">{t("count", { count: total })}</span>
        </div>
        <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
        {rows.length === 0 ? (
          <SectionEmpty>{actor || entityType ? t("emptyFiltered") : t("emptyNone")}</SectionEmpty>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="hidden h-9 w-44 pl-5 text-xs font-medium text-muted-foreground sm:table-cell">
                  {t("time")}
                </TableHead>
                <TableHead className="h-9 pl-4 text-xs font-medium text-muted-foreground sm:pl-2">{t("event")}</TableHead>
                <TableHead className="hidden h-9 w-[38%] pr-4 text-xs font-medium text-muted-foreground sm:table-cell sm:pr-5">
                  {t("data")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const actionLabel = label("actions", r.action);
                // Settings changes name their domain ("sandbox"), or "app" from before the settings had domains.
                const settingsChange = r.action === "settings.updated";
                const entity = settingsChange && r.entityId ? label("domains", r.entityId) : null;
                const data = settingsChange ? (
                  <AuditSettingsChanges data={r.data} />
                ) : (
                  <AuditData data={r.data} hide={t("hide")} />
                );
                return (
                  <TableRow key={r.id} className="border-border/60 hover:bg-muted/30 [&>td]:py-3 [&>td]:align-top">
                    <TableCell
                      className="hidden pl-5 text-muted-foreground sm:table-cell"
                      title={fmt.dateTime(r.createdAt)}
                    >
                      <div className="flex flex-col whitespace-normal">
                        <span className="tabular text-xs text-foreground sm:text-sm sm:whitespace-nowrap">
                          {fmt.dateTime(r.createdAt)}
                        </span>
                        <span className="text-xs">{fmt.relative(r.createdAt)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="pl-4 whitespace-normal sm:pl-2">
                      <div className="flex min-w-0 flex-col gap-1">
                        {/* On a phone the time column is gone: the time leads the event instead. */}
                        <span className="tabular text-xs text-muted-foreground sm:hidden">
                          {fmt.dateTime(r.createdAt)} · {fmt.relative(r.createdAt)}
                        </span>
                        <span
                          className={cn(
                            "text-sm font-medium [overflow-wrap:anywhere]",
                            !actionLabel && "font-mono text-xs",
                          )}
                          title={r.action}
                        >
                          {actionLabel ?? r.action}
                        </span>
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge
                            variant={r.actor === "user" ? "secondary" : "outline"}
                            className="max-w-full font-normal"
                            title={r.actor}
                          >
                            <span className="truncate">{label("actors", r.actor) ?? r.actor}</span>
                          </Badge>
                          <span className="min-w-0 [overflow-wrap:anywhere]">
                            {label("entities", r.entityType) ?? r.entityType}
                          </span>
                        </div>
                        {entity ? (
                          <span className="truncate text-xs text-muted-foreground">{entity}</span>
                        ) : (
                          r.entityId && (
                            <span className="truncate font-mono text-xs text-muted-foreground/80" title={r.entityId}>
                              {r.entityId}
                            </span>
                          )
                        )}
                        <div className="sm:hidden">{data}</div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden pr-4 whitespace-normal sm:table-cell sm:pr-5">{data}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {pages > 1 && (
          <nav
            aria-label={t("pagination")}
            className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 sm:px-5"
          >
            <span className="tabular text-sm text-muted-foreground">{t("page", { page, pages })}</span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(page - 1)}>
                    <ChevronLeft /> {t("previous")}
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  <ChevronLeft /> {t("previous")}
                </Button>
              )}
              {page < pages ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(page + 1)}>
                    {t("next")} <ChevronRight />
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  {t("next")} <ChevronRight />
                </Button>
              )}
            </div>
          </nav>
        )}
      </section>
    </>
  );
}

function AuditData({ data, hide }: { data: Record<string, unknown>; hide: string }) {
  const keys = Object.keys(data);
  if (!keys.length) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer text-xs text-muted-foreground select-none [overflow-wrap:anywhere] hover:text-foreground">
        <span className="group-open:hidden">
          {keys.slice(0, 4).join(", ")}
          {keys.length > 4 ? ", ..." : ""}
        </span>
        <span className="hidden group-open:inline">{hide}</span>
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}
