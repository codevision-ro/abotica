"use client";

import { FormSection } from "@/components/app/form-section";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard, SectionEmpty, SectionIcon, SectionList, SectionRow } from "@/components/app/section-card";
import { LockKeyhole, LogOut, MonitorSmartphone, Monitor, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";

const MIN_PASSWORD = 10;

export function ChangePasswordCard() {
  const t = useTranslations("settings.security");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch || tooShort) return;
    setPending(true);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) return void toast.error(error.message ?? t("changeFailed"));
    setCurrent("");
    setNext("");
    setConfirm("");
    toast.success(t("changed"));
  }

  return (
    <form onSubmit={submit}>
      <FormSection
        id="change-password"
        icon={LockKeyhole}
        title={t("changePasswordTitle")}
        description={t("changePasswordDescription")}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field className="sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]">
            <FieldLabel htmlFor="current-password">{t("currentPassword")}</FieldLabel>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </Field>
          <Field data-invalid={tooShort}>
            <FieldLabel htmlFor="new-password">{t("newPassword")}</FieldLabel>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={tooShort}
              required
            />
            <FieldDescription>{t("minLength", { min: MIN_PASSWORD })}</FieldDescription>
          </Field>
          <Field data-invalid={mismatch}>
            <FieldLabel htmlFor="confirm-password">{t("confirmPassword")}</FieldLabel>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
              required
            />
            {mismatch && <FieldDescription>{t("mismatch")}</FieldDescription>}
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="outline" disabled={pending || !current || !next || mismatch || tooShort}>
            {pending && <Spinner />} {t("changePassword")}
          </Button>
        </div>
      </FormSection>
    </form>
  );
}

type SessionRow = {
  id: string;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Browser and OS from a user agent; `os` is empty when unknown, `browser` null when there is no user agent. */
function describeAgent(ua: string | null | undefined): { browser: string | null; os: string; mobile: boolean } {
  if (!ua) return { browser: null, os: "", mobile: false };
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /curl/i.test(ua)
            ? "curl"
            : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return { browser, os, mobile };
}

async function fetchSessions(fallbackError: string): Promise<SessionRow[]> {
  const { data, error } = await authClient.listSessions();
  if (error) {
    toast.error(error.message ?? fallbackError);
    return [];
  }
  return [...(data ?? [])].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function SessionsCard({ currentSessionId }: { currentSessionId: string }) {
  const t = useTranslations("settings.security");
  const fmt = useFormat();
  const loadError = t("sessionsLoadFailed");
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => setSessions(await fetchSessions(loadError)), [loadError]);

  useEffect(() => {
    let active = true;
    void fetchSessions(loadError).then((rows) => active && setSessions(rows));
    return () => {
      active = false;
    };
  }, [loadError]);

  async function revoke(token: string) {
    setRevoking(token);
    const { error } = await authClient.revokeSession({ token });
    setRevoking(null);
    if (error) return void toast.error(error.message ?? t("revokeFailed"));
    toast.success(t("revoked"));
    await load();
  }

  return (
    <SectionCard
      icon={MonitorSmartphone}
      title={t("sessionsTitle")}
      count={sessions?.length}
      description={t("sessionsDescription")}
      flush
    >
      {sessions === null ? (
        <SectionList>
          {Array.from({ length: 2 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
            </li>
          ))}
        </SectionList>
      ) : sessions.length === 0 ? (
        <SectionEmpty>{t("noSessions")}</SectionEmpty>
      ) : (
        <SectionList>
          {sessions.map((s) => {
            const agent = describeAgent(s.userAgent);
            const deviceLabel = !agent.browser
              ? t("unknownDevice")
              : agent.os
                ? t("browserOn", { browser: agent.browser, os: agent.os })
                : agent.browser;
            const current = s.id === currentSessionId;
            return (
              <SectionRow
                key={s.id}
                media={
                  <SectionIcon
                    icon={agent.mobile ? Smartphone : Monitor}
                    className={cn(!current && "bg-muted text-muted-foreground dark:bg-muted")}
                  />
                }
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{deviceLabel}</span>
                    {current && (
                      <Badge className="shrink-0 bg-success/10 font-normal text-success">{t("currentSession")}</Badge>
                    )}
                  </span>
                }
                subtitle={
                  <span
                    title={t("sessionDates", { created: fmt.dateTime(s.createdAt), expires: fmt.dateTime(s.expiresAt) })}
                  >
                    {s.ipAddress || t("unknownIp")} ·{" "}
                    {t.rich("sessionActive", { time: () => <RelativeTime date={s.updatedAt} /> })}
                  </span>
                }
                trailing={
                  !current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void revoke(s.token)}
                      disabled={revoking === s.token}
                    >
                      {revoking === s.token ? <Spinner /> : <LogOut />}
                      <span className="max-sm:sr-only">{t("revoke")}</span>
                    </Button>
                  )
                }
              />
            );
          })}
        </SectionList>
      )}
    </SectionCard>
  );
}
