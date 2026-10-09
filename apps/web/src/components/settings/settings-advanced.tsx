"use client";

import { SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormSectionCollapsible } from "@/components/app/form-section";
import { FieldGroup } from "@/components/ui/field";

/**
 * The "Advanced" section of a settings page: closed, with its values in one line, and opened by itself
 * while one of its fields has a problem, so the save bar's "needs fixing" never points at a hidden field.
 */
export function SettingsAdvanced({
  id,
  summary,
  invalid,
  children,
}: {
  id: string;
  summary: React.ReactNode;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("settings.form");
  const [open, setOpen] = useState(false);
  return (
    <FormSectionCollapsible
      id={id}
      icon={SlidersHorizontal}
      title={t("advanced")}
      summary={summary}
      open={open || Boolean(invalid)}
      onOpenChange={setOpen}
    >
      <FieldGroup>{children}</FieldGroup>
    </FormSectionCollapsible>
  );
}
