"use client";

import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

/** Password-style input with a toggle that shows what is being typed; stored values are never loaded into it. */
export function SecretInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  const t = useTranslations("settings.secretInput");
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup className={className}>
      <InputGroupInput
        type={visible ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={visible ? t("hide") : t("show")}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
