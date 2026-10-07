"use client";

import { CornerDownLeft, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { type QueryParams, useQueryUpdate } from "@/hooks/use-query-update";
import { cn } from "@/lib/utils";

/** Search box stored in `?q=`; it runs on Enter, which the hint on the right shows while the text is new. */
export function QuerySearch({
  params,
  placeholder,
  label,
  className,
}: {
  params: QueryParams;
  placeholder: string;
  label: string;
  className?: string;
}) {
  const t = useTranslations("memory.search");
  const [value, setValue] = useState(params.q ?? "");
  const { update, pending } = useQueryUpdate(params);
  const dirty = value.trim() !== (params.q ?? "") && !!value.trim();
  return (
    <form
      role="search"
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        update({ q: value.trim() || null, page: null });
      }}
    >
      <InputGroup
        className={cn(
          "h-10 rounded-xl border-border/70 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:bg-card/40",
          params.q && "border-primary/40",
        )}
      >
        <InputGroupAddon className="pl-3">{pending ? <Spinner /> : <Search />}</InputGroupAddon>
        <InputGroupInput
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {(dirty || params.q) && (
          <InputGroupAddon align="inline-end" className="gap-1 pr-2">
            {dirty && (
              <Kbd className="max-sm:hidden" aria-hidden>
                <CornerDownLeft />
              </Kbd>
            )}
            {params.q && (
              <InputGroupButton
                size="icon-xs"
                aria-label={t("clear")}
                title={t("clear")}
                onClick={() => {
                  setValue("");
                  update({ q: null });
                }}
              >
                <X />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        )}
      </InputGroup>
    </form>
  );
}
