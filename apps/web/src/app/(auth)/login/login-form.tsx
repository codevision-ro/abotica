"use client";

import { safeReturnPath } from "@abotica/core/return-path";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../auth-card";
import { useAuthError } from "../use-auth-error";

export function LoginForm() {
  const router = useRouter();
  // Only same-site paths: anything that could resolve to another host falls back to "/".
  const next = safeReturnPath(useSearchParams().get("next"));
  const [pending, setPending] = useState(false);
  const t = useTranslations("auth");
  const errorMessage = useAuthError();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) {
      // Select the password so it can be retyped straight away.
      const password = formElement.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.select();
      return void toast.error(errorMessage(error, t("login.failed")));
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return; // handled by onTwoFactorRedirect
    router.replace(next);
    router.refresh();
  }

  return (
    <AuthCard title={t("login.title")} description={t("login.description")}>
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">{t("fields.email")}</FieldLabel>
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">{t("fields.password")}</FieldLabel>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </Field>
          <Button type="submit" size="lg" disabled={pending}>
            {pending && <Spinner />}
            {t("login.submit")}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
