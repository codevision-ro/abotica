import { CompassIcon, LibraryIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { TabNav } from "@/components/app/tab-nav";
import { SkillDiscover } from "@/components/skills/skill-discover";
import { SkillImportDialog } from "@/components/skills/skill-import-dialog";
import { SkillList } from "@/components/skills/skill-list";
import { Button } from "@/components/ui/button";
import { listInstalledSources, listSkills } from "@/server/queries/skills";

const TABS = ["installed", "discover"] as const;

type TabId = (typeof TABS)[number];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("skills.meta");
  return { title: t("title") };
}

export default async function SkillsPage(props: PageProps<"/skills">) {
  const sp = await props.searchParams;
  const tab: TabId = TABS.some((id) => id === sp.tab) ? (sp.tab as TabId) : "installed";
  const q = typeof sp.q === "string" ? sp.q : "";
  const [skills, installed, t] = await Promise.all([
    tab === "installed" ? listSkills() : [],
    listInstalledSources(),
    getTranslations("skills.list"),
  ]);

  const tabIcons: Record<TabId, React.ReactNode> = {
    installed: <LibraryIcon />,
    discover: <CompassIcon />,
  };

  return (
    <PageBody>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <SkillImportDialog installed={installed} />
            <Button asChild>
              <Link href="/skills/new">
                <PlusIcon /> {t("new")}
              </Link>
            </Button>
          </>
        }
      />
      <TabNav
        items={TABS.map((id) => ({
          href: `/skills?tab=${id}`,
          label: t(`tabs.${id}`),
          icon: tabIcons[id],
          active: id === tab,
        }))}
      />
      {tab === "installed" && <SkillList skills={skills} />}
      {tab === "discover" && <SkillDiscover initialQuery={q} installed={installed} />}
    </PageBody>
  );
}
