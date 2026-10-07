import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ChangePasswordCard, SessionsCard } from "@/components/settings/account-security";
import { SectionHeader } from "@/components/settings/section-header";
import { TwoFactorCard } from "@/components/settings/two-factor-card";
import { getSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("security") };
}

export default async function SecurityPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const t = await getTranslations("settings.security");
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <TwoFactorCard enabled={Boolean(session.user.twoFactorEnabled)} />
      <ChangePasswordCard />
      <SessionsCard currentSessionId={session.session.id} />
    </>
  );
}
