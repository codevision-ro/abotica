"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentAvatar, avatarColors } from "@/components/app/agent-avatar";
import { AGENT_ICONS, AVATAR_PALETTE, agentIcon } from "@/components/app/agent-icons";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-f]{6}$/i;

/** Every word of the query must appear in the icon name or its tags. */
function searchIcons(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return AGENT_ICONS;
  return AGENT_ICONS.filter((i) => {
    const haystack = `${i.name} ${i.tags ?? ""}`;
    return words.every((w) => haystack.includes(w));
  });
}

/** Icon, color and background for an agent avatar; the trigger is the child element. */
export function AvatarPicker({
  value,
  onChange,
  children,
}: {
  value: AgentAvatarValue;
  onChange: (next: AgentAvatarValue) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("agents.avatar");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const icons = searchIcons(query);
  const Current = agentIcon(value.icon);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0">
        <div className="flex items-center gap-3 border-b p-3">
          <AgentAvatar avatar={value} size="xl" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("title")}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{value.icon}</p>
          </div>
        </div>

        <div className="flex flex-col gap-2 p-3">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search")}
              aria-label={t("search")}
            />
          </InputGroup>
          {icons.length ? (
            <div className="-mx-1 grid max-h-44 grid-cols-8 gap-0.5 overflow-y-auto px-1 py-0.5">
              {icons.map(({ name, Icon }) => {
                const selected = name === value.icon;
                const tone = selected ? avatarColors(value) : undefined;
                return (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    aria-label={t("iconOption", { name })}
                    aria-pressed={selected}
                    onClick={() => onChange({ ...value, icon: name })}
                    style={tone?.style}
                    data-tone={tone?.["data-tone"]}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      tone
                        ? [tone.className, "ring-2 ring-primary ring-offset-1 ring-offset-popover"]
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">{t("noResults")}</p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t p-3">
          <p className="text-xs font-medium text-muted-foreground">{t("colors")}</p>
          <div className="grid grid-cols-8 gap-1.5">
            {AVATAR_PALETTE.map((pair, i) => {
              const selected = pair.color === value.color && pair.background === value.background;
              const tone = avatarColors(pair);
              return (
                <button
                  key={`${pair.color}-${pair.background}`}
                  type="button"
                  aria-label={t("paletteOption", { n: i + 1 })}
                  aria-pressed={selected}
                  onClick={() => onChange({ ...value, ...pair })}
                  style={tone.style}
                  data-tone={tone["data-tone"]}
                  className={cn(
                    tone.className,
                    "flex aspect-square items-center justify-center rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]",
                    selected && "ring-2 ring-primary ring-offset-2 ring-offset-popover",
                  )}
                >
                  <Current className="size-3.5" aria-hidden />
                </button>
              );
            })}
          </div>
          <div className="mt-1 grid grid-cols-2 gap-3">
            <ColorField
              id="avatar-color"
              label={t("iconColor")}
              value={value.color}
              onChange={(color) => onChange({ ...value, color })}
            />
            <ColorField
              id="avatar-background"
              label={t("background")}
              value={value.background}
              onChange={(background) => onChange({ ...value, background })}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Native color well plus a hex field; the hex applies once it is a full #rrggbb. */
function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  // Follow changes made elsewhere (palette, color well) without an effect.
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <span
          className="relative size-8 shrink-0 overflow-hidden rounded-md border shadow-xs focus-within:ring-3 focus-within:ring-ring/50"
          style={{ backgroundColor: value }}
        >
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            aria-label={label}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </span>
        <Input
          id={id}
          value={text}
          onChange={(e) => {
            const raw = e.target.value.trim();
            setText(raw);
            const hex = raw.startsWith("#") ? raw : `#${raw}`;
            if (HEX.test(hex)) onChange(hex.toLowerCase());
          }}
          onBlur={() => setText(value)}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 font-mono text-xs"
        />
      </div>
    </div>
  );
}
