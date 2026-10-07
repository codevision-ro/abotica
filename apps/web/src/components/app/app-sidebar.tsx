"use client";

import { ChevronsUpDown, LogOut, Monitor, Moon, ShieldCheck, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Logo } from "@/components/app/logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { isActive, NAV } from "./nav";

type Props = {
  user: { name: string; email: string };
  badges: Partial<Record<string, number>>;
};

/** Active item: a quiet primary tint with a primary icon, so the current page reads at a glance in both modes. */
const NAV_BUTTON =
  "h-9 gap-2.5 rounded-lg px-2.5 text-sidebar-foreground/80 transition-colors [&>svg]:text-sidebar-foreground/60 hover:[&>svg]:text-sidebar-foreground data-[active=true]:bg-primary/8 data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[active=true]:[&>svg]:text-primary dark:data-[active=true]:bg-primary/15";

function UserAvatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <Avatar className={cn("size-8 rounded-lg", className)}>
      <AvatarFallback className="rounded-lg bg-primary/12 text-xs font-semibold text-primary dark:bg-primary/20">
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}

export function AppSidebar({ user, badges }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { isMobile, state, setOpenMobile } = useSidebar();
  // On mobile the sidebar is a sheet over the page: any navigation from it should reveal the page.
  const closeOnMobile = () => isMobile && setOpenMobile(false);
  const t = useTranslations("shell.sidebar");
  const tNav = useTranslations("nav");
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="rounded-lg hover:bg-transparent active:bg-transparent" asChild>
              <Link href="/" onClick={closeOnMobile}>
                <Logo />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold tracking-tight">Abotica</span>
                  <span className="truncate text-xs text-muted-foreground">{t("subtitle")}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-1">
        {NAV.map((group, index) => (
          <SidebarGroup key={group.key} className="py-1">
            {/* Labels fold away in icon mode; a hairline keeps the groups apart there. */}
            {index > 0 && <SidebarSeparator className="mx-1.5 mb-1 hidden w-auto! group-data-[collapsible=icon]:block" />}
            <SidebarGroupLabel className="h-7 px-2.5 text-[11px] font-medium tracking-wider text-sidebar-foreground/50 uppercase">
              {tNav(`groups.${group.key}`)}
            </SidebarGroupLabel>
            <SidebarMenu className="gap-0.5">
              {group.items.map((item) => {
                const title = tNav(`items.${item.key}`);
                const count = badges[item.href];
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(pathname, item.href)}
                      tooltip={count ? t("badgeTooltip", { title, count }) : title}
                      className={NAV_BUTTON}
                    >
                      <Link href={item.href as never} onClick={closeOnMobile}>
                        <item.icon />
                        <span>{title}</span>
                      </Link>
                    </SidebarMenuButton>
                    {count ? (
                      <>
                        <SidebarMenuBadge className="top-2! right-1.5 rounded-full bg-primary/12 px-1.5 text-[11px] text-primary peer-hover/menu-button:text-primary peer-data-active/menu-button:text-primary dark:bg-primary/20">
                          {count}
                        </SidebarMenuBadge>
                        <span
                          aria-hidden
                          className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[collapsible=icon]:block"
                        />
                      </>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={state === "collapsed" ? user.name : undefined}
                  className="rounded-xl border border-transparent hover:border-sidebar-border hover:bg-background/70 data-[state=open]:border-sidebar-border data-[state=open]:bg-background/70 group-data-[collapsible=icon]:border-0 dark:hover:bg-sidebar-accent dark:data-[state=open]:bg-sidebar-accent"
                >
                  <UserAvatar initials={initials} />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side={isMobile || state === "expanded" ? "top" : "right"}
                align={isMobile || state === "expanded" ? "start" : "end"}
                sideOffset={8}
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-xl"
              >
                <DropdownMenuLabel className="flex items-center gap-2.5 px-2 py-1.5 font-normal">
                  <UserAvatar initials={initials} />
                  <div className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate text-sm font-medium text-foreground">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("theme")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                    <DropdownMenuRadioItem value="light">
                      <Sun /> {t("themeLight")}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <Moon /> {t("themeDark")}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">
                      <Monitor /> {t("themeSystem")}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings/security" onClick={closeOnMobile}>
                    <ShieldCheck /> {t("security")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={async () => {
                    await authClient.signOut();
                    router.replace("/login");
                  }}
                >
                  <LogOut /> {t("signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
