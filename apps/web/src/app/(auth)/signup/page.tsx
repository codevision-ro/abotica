import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { SETUP_CODE_HEADER, setupCodeRequired, signupOpen } from "@/server/auth";
import { SignupForm } from "./signup-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signup");
  return { title: t("metaTitle") };
}

export default async function SignupPage(props: { searchParams: Promise<{ code?: string | string[] }> }) {
  await connection(); // the answer depends on the database at request time
  if (!(await signupOpen())) redirect("/login");
  const { code } = await props.searchParams;
  return (
    <SignupForm
      setupCode={setupCodeRequired() ? { header: SETUP_CODE_HEADER, initial: typeof code === "string" ? code : "" } : null}
    />
  );
}
