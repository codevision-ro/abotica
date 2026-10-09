import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { AppSidebar } from "@/components/app/app-sidebar";
import { CommandMenu } from "@/components/app/command-menu";
import { KillSwitch } from "@/components/app/kill-switch";
import { LiveUpdates } from "@/components/app/live-updates";
import { TimeZoneDetect } from "@/components/settings/time-zone-detect";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { getInboxCount } from "@/server/queries/inbox";
import { getKillSwitchState, getTimeZoneUnset } from "@/server/queries/settings";
import { getAvailableUpdate } from "@/server/queries/updates";
import { requireUser } from "@/server/session";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const [t, killed, waiting, update, timeZoneUnset, cookieStore] = await Promise.all([
    getTranslations("shell.header"),
    getKillSwitchState(),
    getInboxCount(),
    getAvailableUpdate(),
    getTimeZoneUnset(),
    cookies(),
  ]);
  // Keep the desktop sidebar collapsed across reloads (the sidebar writes this cookie when toggled).
  const sidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <LiveUpdates>
      {timeZoneUnset && <TimeZoneDetect />}
      <SidebarProvider defaultOpen={sidebarOpen}>
        <AppSidebar user={{ name: user.name, email: user.email }} badges={{ "/inbox": waiting }} update={update} />
        <SidebarInset className="min-w-0 md:border md:border-border/60">
          {/* The kill switch state lives in the header (fixed height), so full-height pages like chat keep fitting. */}
          <header
            className={cn(
              "sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background/85 px-3 backdrop-blur-md md:rounded-t-xl md:px-4",
              killed && "border-destructive/25 bg-[color-mix(in_oklch,var(--destructive)_4%,var(--background))]",
            )}
          >
            <SidebarTrigger className="size-9 text-muted-foreground hover:text-foreground md:size-8" />
            <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
            <CommandMenu />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {killed && (
                <span className="hidden items-center gap-2 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive md:inline-flex">
                  <span className="size-1.5 animate-pulse rounded-full bg-current" />
                  {t("agentsStopped")}
                </span>
              )}
              <KillSwitch active={killed} />
            </div>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </LiveUpdates>
  );
}
