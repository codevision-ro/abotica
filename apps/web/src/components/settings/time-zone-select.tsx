"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Every zone this browser knows, plus UTC, which some engines leave out of the list. */
function listTimeZones(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/** Searchable list of the IANA time zones; the current value is always offered, even one this browser lacks. */
export function TimeZoneSelect({
  id,
  value,
  onChange,
  invalid,
  className,
}: {
  id?: string;
  value: string;
  onChange: (zone: string) => void;
  invalid?: boolean;
  className?: string;
}) {
  const t = useTranslations("settings.general");
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => {
    const all = listTimeZones();
    return all.includes(value) ? all : [value, ...all];
  }, [value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          className={cn("justify-between font-normal", className)}
        >
          <span className="truncate">{value.replaceAll("_", " ")}</span>
          <ChevronsUpDownIcon className="text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="end">
        <Command>
          <CommandInput placeholder={t("timezoneSearch")} />
          <CommandList>
            <CommandEmpty>{t("timezoneEmpty")}</CommandEmpty>
            {zones.map((zone) => (
              <CommandItem
                key={zone}
                data-checked={zone === value}
                // Searching "new york" finds America/New_York.
                value={`${zone} ${zone.replaceAll("_", " ")}`}
                onSelect={() => {
                  onChange(zone);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{zone.replaceAll("_", " ")}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
