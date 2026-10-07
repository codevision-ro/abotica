"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { TaskStatusBadge } from "@/components/app/status-badge";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type PickerTask = { id: string; title: string; status: string };

/** Searchable task list in a popover; `selected` items get a check mark. */
export function TaskPicker({
  tasks,
  selected = [],
  onSelect,
  closeOnSelect,
  children,
}: {
  tasks: PickerTask[];
  selected?: string[];
  onSelect: (id: string) => void;
  closeOnSelect?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("tasks.picker");
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder={t("search")} />
          <CommandList>
            <CommandEmpty>{t("empty")}</CommandEmpty>
            {tasks.map((t) => (
              <CommandItem
                key={t.id}
                value={`${t.title} ${t.id}`}
                data-checked={selected.includes(t.id)}
                onSelect={() => {
                  onSelect(t.id);
                  if (closeOnSelect) setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate" title={t.title}>
                  {t.title}
                </span>
                <TaskStatusBadge status={t.status} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
