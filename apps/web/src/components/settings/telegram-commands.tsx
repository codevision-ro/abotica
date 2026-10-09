"use client";

import type { TELEGRAM_COMMANDS } from "@abotica/core/telegram-commands";
import { SquareSlash } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormSectionCollapsible } from "@/components/app/form-section";

/** The bot's commands, closed to one line of their names until opened. */
export function TelegramCommands({ commands }: { commands: typeof TELEGRAM_COMMANDS }) {
  const t = useTranslations("settings.telegram");
  const tb = useTranslations("telegram.commands");
  const [open, setOpen] = useState(false);
  return (
    <FormSectionCollapsible
      id="telegram-commands"
      icon={SquareSlash}
      title={t("commandsTitle")}
      summary={commands.map((command) => `/${command}`).join(" ")}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-pretty text-muted-foreground">{t("commandsDescription")}</p>
        <ul className="flex flex-col gap-2.5">
          {commands.map((command) => (
            <li key={command} className="flex min-w-0 items-baseline gap-3">
              <span className="w-20 shrink-0 font-mono text-sm font-medium">/{command}</span>
              <span className="min-w-0 text-sm text-pretty text-muted-foreground">{tb(command)}</span>
            </li>
          ))}
        </ul>
      </div>
    </FormSectionCollapsible>
  );
}
