"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../auth-card";
import { useAuthError } from "../use-auth-error";

/** `setupCode`: set when the instance has a SETUP_CODE; the link install.sh prints carries it in ?code=. */
export function SignupForm({ setupCode }: { setupCode: { header: string; initial: string } | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const t = useTranslations("auth");
  const errorMessage = useAuthError();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
      fetchOptions: setupCode ? { headers: { [setupCode.header]: String(form.get("setupCode")) } } : undefined,
    });
    setPending(false);
    if (error) return void toast.error(errorMessage(error, t("signup.failed")));
    toast.success(t("signup.created"));
    router.replace("/settings/security");
    router.refresh();
  }

  return (
    <AuthCard title={t("signup.title")} description={t("signup.description")}>
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">{t("fields.name")}</FieldLabel>
            <Input id="name" name="name" autoComplete="name" required autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">{t("fields.email")}</FieldLabel>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">{t("fields.password")}</FieldLabel>
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
            <FieldDescription>{t("signup.passwordHint")}</FieldDescription>
          </Field>
          {setupCode && (
            <Field>
              <FieldLabel htmlFor="setupCode">{t("fields.setupCode")}</FieldLabel>
              <Input
                id="setupCode"
                name="setupCode"
                defaultValue={setupCode.initial}
                autoComplete="off"
                spellCheck={false}
                required
              />
              <FieldDescription>{t("signup.setupCodeHint")}</FieldDescription>
            </Field>
          )}
          <Button type="submit" size="lg" disabled={pending}>
            {pending && <Spinner />}
            {t("signup.submit")}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
