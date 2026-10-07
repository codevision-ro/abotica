import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { McpList } from "@/components/mcp/mcp-list";
import { Button } from "@/components/ui/button";
import { listMcpServerGroups } from "@/server/queries/mcp";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mcp.meta");
  return { title: t("title") };
}

export default async function McpPage() {
  const [{ builtin, user }, t] = await Promise.all([listMcpServerGroups(), getTranslations("mcp.list")]);
  return (
    <PageBody>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild>
            <Link href="/mcp/new">
              <Plus /> {t("new")}
            </Link>
          </Button>
        }
      />
      <McpList builtin={builtin} user={user} />
    </PageBody>
  );
}
