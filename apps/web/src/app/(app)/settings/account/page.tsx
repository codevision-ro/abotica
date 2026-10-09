import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ChangePasswordCard, SessionsCard } from "@/components/settings/account-security";
import { SectionHeader } from "@/components/settings/section-header";
import { SessionLengthForm } from "@/components/settings/session-length-form";
import { TwoFactorCard } from "@/components/settings/two-factor-card";
import { getAppSettings } from "@/server/queries/settings";
import { getSession } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("account") };
}

/** Settings > Account: sign-in security and how long a session lasts. */
export default async function AccountPage() {
  const [session, settings, t] = await Promise.all([getSession(), getAppSettings(), getTranslations("settings.security")]);
  if (!session) redirect("/login");
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <TwoFactorCard enabled={Boolean(session.user.twoFactorEnabled)} />
      <ChangePasswordCard />
      <SessionsCard currentSessionId={session.session.id} />
      <SessionLengthForm initial={settings.security} />
    </>
  );
}
