"use client";

import { isTelegramChatId, parseTelegramUserIds } from "@abotica/core/telegram-ids";
import { Bot, CircleCheck, Trash2, TriangleAlert, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-dialog";
import { FormSection } from "@/components/app/form-section";
import { RelativeTime } from "@/components/app/relative-time";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useDirtySnapshot } from "@/hooks/use-dirty-snapshot";
import { deleteTelegramToken, updateTelegramSettings } from "@/server/actions/telegram";
import type { TelegramStatus } from "@/server/queries/settings";
import { SecretInput } from "./secret-input";
import { SettingsSaveBar } from "./settings-save-bar";

type Props = Pick<TelegramStatus, "tokenUpdatedAt" | "allowedUserIds" | "notifyChatId" | "bot">;

const mono = (chunks: React.ReactNode) => <span className="font-mono text-[0.9em]">{chunks}</span>;

/**
 * Settings > Telegram: the bot token, who may talk to the bot and where notifications go, saved
 * together. The stored token never comes back to the browser; the page only knows that one is set.
 */
export function TelegramSettingsForm({ tokenUpdatedAt, allowedUserIds, notifyChatId, bot }: Props) {
  const t = useTranslations("settings.telegram");
  const tv = useTranslations("settings.validation.telegram");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState({ users: allowedUserIds.join(", "), notify: notifyChatId ?? "" });
  const [users, setUsers] = useState(saved.users);
  const [notify, setNotify] = useState(saved.notify);
  const [saving, startSave] = useTransition();
  const [removing, startRemove] = useTransition();
  const hasToken = tokenUpdatedAt !== null;

  const userIds = parseTelegramUserIds(users);
  const notifyValue = notify.trim() || null;
  const usersInvalid = userIds === null;
  const notifyInvalid = notifyValue !== null && !isTelegramChatId(notifyValue);
  const snapshot = (u: string, n: string, tok: string) => ({
    users: parseTelegramUserIds(u) ?? u,
    notify: n.trim(),
    tok: tok.trim(),
  });
  const { dirty, markSaved } = useDirtySnapshot(snapshot(users, notify, token));

  function save() {
    if (!userIds || notifyInvalid) return;
    startSave(async () => {
      const res = await updateTelegramSettings({ token, allowedUserIds: userIds, notifyChatId: notifyValue });
      if (!res.ok) return void toast.error(res.error);
      const next = { users: userIds.join(", "), notify: notifyValue ?? "" };
      setToken("");
      setUsers(next.users);
      setNotify(next.notify);
      setSaved(next);
      markSaved(snapshot(next.users, next.notify, ""));
      toast.success(res.data.username ? t("savedConnected", { username: res.data.username }) : t("saved"));
      router.refresh();
    });
  }

  function reset() {
    setToken("");
    setUsers(saved.users);
    setNotify(saved.notify);
  }

  function removeToken() {
    startRemove(async () => {
      const res = await deleteTelegramToken({});
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("tokenRemoved"));
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <FormSection
        id="telegram-bot"
        icon={Bot}
        title={t("botTitle")}
        description={t("botDescription")}
        action={<BotBadge hasToken={hasToken} bot={bot} />}
      >
        {hasToken && <BotState bot={bot} />}
        <Field>
          <FieldLabel htmlFor="telegram-token">{hasToken ? t("replaceToken") : t("token")}</FieldLabel>
          <SecretInput
            id="telegram-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? "••••••••" : "123456789:AA..."}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <FieldDescription>
              {hasToken
                ? t.rich("tokenStored", { time: () => <RelativeTime date={tokenUpdatedAt} /> })
                : t.rich("tokenHint", { mono })}
            </FieldDescription>
            {hasToken && (
              <ConfirmButton
                className="-mr-2 shrink-0 text-muted-foreground hover:text-destructive"
                destructive
                icon={Trash2}
                label={t("removeToken")}
                title={t("removeTitle")}
                description={t("removeDescription")}
                confirm={tc("delete")}
                pending={removing}
                onConfirm={removeToken}
              />
            )}
          </div>
        </Field>
      </FormSection>

      <FormSection id="telegram-access" icon={Users} title={t("accessTitle")} description={t("accessDescription")}>
        <FieldGroup>
          <Field data-invalid={usersInvalid}>
            <FieldLabel htmlFor="telegram-users">{t("allowedUsers")}</FieldLabel>
            <Input
              id="telegram-users"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={users}
              onChange={(e) => setUsers(e.target.value)}
              placeholder="123456789, 987654321"
              aria-invalid={usersInvalid}
              className="font-mono"
            />
            <FieldDescription>{usersInvalid ? tv("userIds") : t.rich("allowedUsersHint", { mono })}</FieldDescription>
          </Field>
          <FieldSeparator />
          <Field data-invalid={notifyInvalid}>
            <FieldLabel htmlFor="telegram-notify">{t("notifyChat")}</FieldLabel>
            <Input
              id="telegram-notify"
              autoComplete="off"
              spellCheck={false}
              value={notify}
              onChange={(e) => setNotify(e.target.value)}
              placeholder={userIds?.[0] ? String(userIds[0]) : "-1001234567890"}
              aria-invalid={notifyInvalid}
              className="font-mono sm:w-64"
            />
            <FieldDescription>{notifyInvalid ? tv("chatId") : t("notifyChatHint")}</FieldDescription>
          </Field>
        </FieldGroup>
      </FormSection>

      <SettingsSaveBar form={{ dirty, invalid: usersInvalid || notifyInvalid, pending: saving, save, reset }} />
    </div>
  );
}

/** Connected, error, starting, or not configured, from what the worker reports. */
function BotBadge({ hasToken, bot }: { hasToken: boolean; bot: Props["bot"] }) {
  const t = useTranslations("settings.telegram");
  if (!hasToken) {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        {t("state.notConfigured")}
      </Badge>
    );
  }
  if (bot?.state === "running") {
    return (
      <Badge className="bg-success/10 font-normal text-success">
        <span aria-hidden className="size-1.5 rounded-full bg-current" /> {t("state.connected")}
      </Badge>
    );
  }
  if (bot?.state === "error") {
    return (
      <Badge variant="destructive" className="font-normal">
        {t("state.error")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" /> {t("state.starting")}
    </Badge>
  );
}

/** One line on what the bot is doing, with the error when it stopped. */
function BotState({ bot }: { bot: Props["bot"] }) {
  const t = useTranslations("settings.telegram");
  if (bot?.state === "running") {
    return (
      <p className="flex items-center gap-2 text-sm">
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
        <span className="min-w-0">
          {t.rich("connectedAs", {
            bot: () => (
              <a
                href={`https://t.me/${bot.username}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline-offset-4 hover:underline"
              >
                @{bot.username}
              </a>
            ),
            time: () => <RelativeTime date={bot.startedAt} />,
          })}
        </span>
      </p>
    );
  }
  if (bot?.state === "error") {
    return (
      <div className="space-y-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3 sm:p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          {t("errorTitle")}
        </p>
        <p className="font-mono text-xs wrap-anywhere text-muted-foreground">{bot.error}</p>
        <p className="text-sm text-pretty">{t("errorHint")}</p>
      </div>
    );
  }
  return <p className="text-sm text-pretty text-muted-foreground">{t("startingHint")}</p>;
}
