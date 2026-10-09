"use client";

import { CheckIcon, ChevronsUpDownIcon, PencilLineIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import type { ModelOption } from "@/server/queries/agents";
import { ModelConsumptionMeter } from "./model-consumption";

function formatContext(value: number | null): string | null {
  if (!value) return null;
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : `${Math.round(value / 1000)}k`;
}

export function ModelMeta({ model }: { model: ModelOption }) {
  const t = useTranslations("agents.model");
  const format = useFormat();
  const ctx = formatContext(model.contextWindow);
  return (
    <span className="tabular text-xs text-muted-foreground">
      {model.cost
        ? t("price", { input: format.modelPrice(model.cost.input), output: format.modelPrice(model.cost.output) })
        : t("unknownPrice")}
      {ctx && ` · ${t("context", { size: ctx })}`}
    </span>
  );
}

export function ModelPicker({
  id,
  provider,
  value,
  onChange,
  models,
  className,
}: {
  id?: string;
  provider: string;
  value: string;
  onChange: (model: string) => void;
  models: ModelOption[];
  className?: string;
}) {
  const t = useTranslations("agents.model");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const options = useMemo(() => models.filter((m) => m.provider === provider), [models, provider]);
  const query = search.trim().toLowerCase();
  const filtered = query
    ? options.filter((m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    : options;
  const custom = search.trim() && !options.some((m) => m.id === search.trim()) ? search.trim() : null;
  const current = options.find((m) => m.id === value);

  function pick(model: string) {
    onChange(model);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          title={value || undefined}
          className={cn("w-full min-w-0 justify-between font-normal", className)}
        >
          <span className={cn("min-w-0 truncate", !value && "text-muted-foreground")}>
            {current ? current.name : value || t("pick")}
            {current && <span className="ml-2 font-mono text-xs text-muted-foreground">{current.id}</span>}
          </span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] min-w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={t("search")} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{t("empty")}</CommandEmpty>
            {custom && (
              <CommandGroup>
                <CommandItem value={`custom:${custom}`} onSelect={() => pick(custom)}>
                  <PencilLineIcon />
                  {t.rich("useCustom", { id: custom, mono: (chunks) => <span className="font-mono">{chunks}</span> })}
                </CommandItem>
              </CommandGroup>
            )}
            {filtered.length > 0 && (
              <CommandGroup heading={t("catalog")}>
                {filtered.map((m) => (
                  <CommandItem key={m.id} value={m.id} onSelect={() => pick(m.id)} className="items-start">
                    <CheckIcon className={cn("mt-0.5", m.id === value ? "opacity-100" : "opacity-0")} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate">{m.name}</span>
                      <span className="flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground">
                        <span className="truncate">{m.id}</span>
                      </span>
                      <ModelMeta model={m} />
                    </div>
                    {m.consumption && <ModelConsumptionMeter consumption={m.consumption} className="mt-0.5 shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
