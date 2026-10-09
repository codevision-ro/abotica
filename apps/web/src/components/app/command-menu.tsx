"use client";

import { ArrowDown, ArrowUp, Bot, CornerDownLeft, FolderKanban, MessagesSquare, Search, SquareKanban } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useStartConversation } from "@/components/chat/start-conversation";
import { SETTINGS_PAGES } from "@/components/settings/settings-pages";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { requestNavigation } from "@/lib/navigation-guard";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";

/** `href: null` runs an action instead of navigating. */
const QUICK_ACTIONS = [
  { key: "newTask", href: "/tasks?new=1", icon: SquareKanban },
  { key: "newProject", href: "/projects/new", icon: FolderKanban },
  { key: "newAgent", href: "/agents/new", icon: Bot },
  { key: "newChat", href: null, icon: MessagesSquare },
] as const;

const ITEM = "h-10 gap-3 px-2";

function ItemIcon({ icon: Icon, action }: { icon: typeof Bot; action?: boolean }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border",
        action
          ? "border-transparent bg-primary/8 text-primary dark:bg-primary/15"
          : "border-border/70 bg-background text-muted-foreground",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

export function CommandMenu() {
  const [open, setOpenState] = useState(false);
  const [search, setSearch] = useState("");
  const { start: startConversation } = useStartConversation();
  const router = useRouter();
  const setOpen = (value: boolean) => {
    setOpenState(value);
    setSearch("");
  };
  const t = useTranslations("shell.commandMenu");
  const tNav = useTranslations("nav");
  const tSettings = useTranslations("settings.nav");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpenState((o) => !o);
        setSearch("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    // Lets an unsaved-changes guard on the current page ask first.
    requestNavigation(href, () => router.push(href as never));
  };
  // "New conversation" really creates one (/chat would reopen the latest conversation).
  const newChat = () => {
    setOpen(false);
    requestNavigation("/chat", () => startConversation());
  };

  const actionItems = QUICK_ACTIONS.map((a) => (
    <CommandItem key={a.key} onSelect={() => (a.href ? go(a.href) : newChat())} className={ITEM}>
      <ItemIcon icon={a.icon} action />
      <span className="truncate">{t(a.key)}</span>
    </CommandItem>
  ));
  const navItems = (items: (typeof NAV)[number]["items"]) =>
    items.map((item) => (
      <CommandItem key={item.href} onSelect={() => go(item.href)} className={ITEM}>
        <ItemIcon icon={item.icon} />
        <span className="truncate">{tNav(`items.${item.key}`)}</span>
      </CommandItem>
    ));
  // Each settings page on its own, so "time zone" or "sandbox" finds where it is set.
  const settingsItems = () =>
    SETTINGS_PAGES.map((page) => (
      <CommandItem
        key={`settings:${page.href}`}
        value={`${tSettings("label")} ${tSettings(page.key)} ${page.href}`}
        keywords={[tSettings(`keywords.${page.key}`)]}
        onSelect={() => go(page.href)}
        className={ITEM}
      >
        <ItemIcon icon={page.icon} />
        <span className="truncate">{tSettings(page.key)}</span>
        <CommandShortcut className="tracking-normal">{tSettings("label")}</CommandShortcut>
      </CommandItem>
    ));

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-9 w-full max-w-72 min-w-0 shrink justify-start gap-2 rounded-lg border-border/70 bg-muted/40 font-normal text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground md:h-8 dark:bg-muted/30 dark:hover:bg-muted/60"
      >
        <Search />
        <span className="flex-1 truncate text-left">{t("trigger")}</span>
        <Kbd className="hidden border border-border/70 bg-background sm:inline-flex">⌘K</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        description={t("description")}
        className="top-[18%] rounded-2xl! shadow-2xl sm:max-w-xl"
      >
        <Command className="rounded-2xl! p-0 **:data-[slot=command-input-wrapper]:p-2 **:data-[slot=command-input-wrapper]:pb-1">
          <CommandInput placeholder={t("placeholder")} value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[min(26rem,60svh)] scroll-py-2 px-1 pb-1">
            <CommandEmpty>{t("empty")}</CommandEmpty>
            {search ? (
              // cmdk does not reorder groups by match quality, so results are one list while searching.
              <CommandGroup>
                {actionItems}
                {navItems(NAV.flatMap((group) => group.items))}
                {settingsItems()}
              </CommandGroup>
            ) : (
              <>
                <CommandGroup heading={t("actions")}>{actionItems}</CommandGroup>
                <CommandSeparator className="mx-1 my-1" />
                {NAV.map((group) => (
                  <CommandGroup key={group.key} heading={tNav(`groups.${group.key}`)}>
                    {navItems(group.items)}
                  </CommandGroup>
                ))}
                <CommandGroup heading={tSettings("label")}>{settingsItems()}</CommandGroup>
              </>
            )}
          </CommandList>
          <div
            aria-hidden
            className="hidden items-center gap-4 border-t border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:flex"
          >
            <span className="flex items-center gap-1.5">
              <KbdGroup>
                <Kbd>
                  <ArrowUp />
                </Kbd>
                <Kbd>
                  <ArrowDown />
                </Kbd>
              </KbdGroup>
              {t("hintNavigate")}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft />
              </Kbd>
              {t("hintOpen")}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              {t("hintClose")}
            </span>
          </div>
        </Command>
      </CommandDialog>
    </>
  );
}
