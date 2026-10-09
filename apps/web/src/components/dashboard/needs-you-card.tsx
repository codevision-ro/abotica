import { CircleHelpIcon, InboxIcon, ListTodoIcon, type LucideIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SectionCard, SectionIcon, SectionList, SectionRow } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { getFormat } from "@/server/format";
import type { InboxPreview } from "@/server/queries/inbox";

const KIND_ICONS: Record<InboxPreview["items"][number]["kind"], LucideIcon> = {
  question: CircleHelpIcon,
  approval: ShieldCheckIcon,
  task: ListTodoIcon,
  blocked: TriangleAlertIcon,
};

/** What waits for the user, oldest first; the dashboard shows it only when something does. */
export async function NeedsYouCard({ preview }: { preview: InboxPreview }) {
  const [t, tKinds, f] = await Promise.all([
    getTranslations("dashboard.needsYou"),
    getTranslations("inbox.kinds"),
    getFormat(),
  ]);
  return (
    <SectionCard
      icon={InboxIcon}
      title={t("title")}
      count={preview.total}
      description={t("description")}
      flush
      action={
        <Button asChild variant="ghost" size="sm">
          <Link href="/inbox">{t("openInbox")}</Link>
        </Button>
      }
    >
      <SectionList>
        {preview.items.map((item) => (
          <SectionRow
            key={`${item.kind}-${item.id}`}
            // Tasks open on their page; questions and approvals are answered in the inbox.
            href={item.kind === "task" || item.kind === "blocked" ? `/tasks/${item.id}` : "/inbox"}
            media={
              <SectionIcon
                icon={KIND_ICONS[item.kind]}
                className={
                  item.kind === "blocked" ? "bg-destructive/10 text-destructive dark:bg-destructive/15" : undefined
                }
              />
            }
            title={<span title={item.title}>{item.title}</span>}
            subtitle={[tKinds(item.kind), item.projectName, f.relative(item.since)].filter(Boolean).join(" · ")}
          />
        ))}
      </SectionList>
    </SectionCard>
  );
}
