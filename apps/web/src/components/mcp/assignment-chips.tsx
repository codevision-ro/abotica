"use client";

import { CheckIcon } from "lucide-react";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { FormSubsection } from "@/components/app/form-section";
import { chipVariants, SelectableChip } from "@/components/app/selectable-chip";
import type { PickerOption } from "@/components/skills/assignment-picker";

const toggle = (list: string[], item: string, on: boolean) =>
  on ? (list.includes(item) ? list : [...list, item]) : list.filter((x) => x !== item);

/** Toggle pills to assign to agents (with their avatars) or projects; one line when there is nothing to pick. */
export function AssignmentChips({
  title,
  items,
  selected,
  onChange,
  empty,
}: {
  title: string;
  items: PickerOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  empty: React.ReactNode;
}) {
  return (
    <FormSubsection title={title} count={selected.length}>
      {items.length ? (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => {
            const on = selected.includes(item.id);
            const change = (next: boolean) => onChange(toggle(selected, item.id, next));
            if (!item.avatar) {
              return (
                <SelectableChip
                  key={item.id}
                  selected={on}
                  onSelectedChange={change}
                  title={item.name}
                  className="max-w-64"
                >
                  {item.name}
                </SelectableChip>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={on}
                title={item.name}
                onClick={() => change(!on)}
                className={chipVariants({ selected: on, className: "max-w-64 pl-1.5" })}
              >
                <AgentAvatar avatar={item.avatar} size="xs" className="rounded-full" />
                <span className="min-w-0 truncate">{item.name}</span>
                {on && <CheckIcon className="text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </FormSubsection>
  );
}
