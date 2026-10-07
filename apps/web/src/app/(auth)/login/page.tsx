import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { signupOpen } from "@/server/auth";
import { getSession } from "@/server/session";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.login");
  return { title: t("metaTitle") };
}

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  const [canSignup, t] = await Promise.all([signupOpen(), getTranslations("auth.login")]);
  return (
    <>
      <Suspense>
        <LoginForm />
      </Suspense>
      {canSignup && (
        <p className="text-center text-sm text-muted-foreground">
          {t.rich("firstAccess", {
            link: (chunks) => (
              <Link href="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
    </>
  );
}
