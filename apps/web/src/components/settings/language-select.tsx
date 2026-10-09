"use client";

import { type Locale, localeNames, locales } from "@abotica/i18n";
import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveSettings } from "@/server/actions/app-settings";
import { InlineSection } from "./inline-section";

const AUTO = "auto";

/** The interface language, saved as soon as it is picked: the page reloads in it at once. */
export function LanguageSelect({ initial }: { initial: Locale | null }) {
  const t = useTranslations("common.language");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function change(value: string) {
    startTransition(async () => {
      const res = await saveSettings({ domain: "general", patch: { locale: value === AUTO ? null : (value as Locale) } });
      if (!res.ok) return void toast.error(res.error);
      router.refresh();
    });
  }

  return (
    <InlineSection titleId="language-title" icon={Languages} title={t("label")} description={t("description")}>
      <Select defaultValue={initial ?? AUTO} onValueChange={change} disabled={pending}>
        <SelectTrigger id="language" aria-labelledby="language-title" className="w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>{t("auto")}</SelectItem>
          {locales.map((l) => (
            <SelectItem key={l} value={l}>
              {localeNames[l]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </InlineSection>
  );
}
