"use client";

import { WEBHOOK_RATE_LIMIT, WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from "@abotica/core/trigger-events";
import {
  CheckIcon,
  CopyIcon,
  MailIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldOffIcon,
  WebhookIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import {
  createTriggerSigningSecret,
  deleteTriggerSigningSecret,
  regenerateTriggerToken,
} from "@/server/actions/automations";
import { DialogHeading, stickyFooterClass } from "./dialog-parts";

export const webhookUrl = (appUrl: string, token: string) => `${appUrl}/api/webhooks/${token}`;

const EXAMPLE_BODY = `{"subject": "New order", "customer": "Jane Doe"}`;
const EXAMPLE_RESPONSE = `202 { "runId": "..." }`;

function useCopy() {
  const t = useTranslations("automations.webhook");
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  };
  return { copied, copy };
}

/** A read-only value with a copy button inside the field. */
function CopyField({
  id,
  value,
  copied,
  onCopy,
  addon,
}: {
  id: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  addon?: React.ReactNode;
}) {
  const tCommon = useTranslations("common");
  return (
    <InputGroup className="h-10">
      {addon && <InputGroupAddon>{addon}</InputGroupAddon>}
      <InputGroupInput id={id} readOnly value={value} className="font-mono text-xs" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton variant="secondary" className="mr-0.5 h-7 px-2" onClick={onCopy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? tCommon("actions.copied") : tCommon("actions.copy")}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export type WebhookTarget = {
  id: string;
  name: string;
  event: string;
  token: string | null;
  signed: boolean;
  /** Requests per minute that may start runs; null (or not known) is the default. */
  rateLimitPerMinute?: number | null;
};

export function WebhookDialog({
  open,
  onOpenChange,
  trigger,
  appUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: WebhookTarget | null;
  appUrl: string;
}) {
  const t = useTranslations("automations.webhook");
  const tCommon = useTranslations("common");
  const [token, setToken] = useState<string | null>(null);
  const [signedNow, setSignedNow] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();
  const { copied, copy } = useCopy();
  const current = token ?? trigger?.token ?? null;
  const signed = signedNow ?? trigger?.signed ?? false;
  const UrlHintIcon = signed ? ShieldCheckIcon : ShieldAlertIcon;
  const url = current ? webhookUrl(appUrl, current) : "";
  const curl = `curl -X POST "${url}" \\\n  -H "Content-Type: application/json" \\\n  -d '${EXAMPLE_BODY}'`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setToken(null);
          setSignedNow(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeading
          icon={trigger?.event === "email.received" ? MailIcon : WebhookIcon}
          title={t("title", { name: trigger?.name ?? "" })}
          description={trigger?.event === "email.received" ? t("descriptionEmail") : t("description")}
        />
        {current ? (
          <div className="flex min-w-0 flex-col gap-5">
            <Field>
              <FieldLabel htmlFor="webhook-url">{t("url")}</FieldLabel>
              <CopyField
                id="webhook-url"
                value={url}
                copied={copied === "url"}
                onCopy={() => copy("url", url)}
                addon={
                  <span className="rounded-md bg-primary/8 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary dark:bg-primary/15">
                    POST
                  </span>
                }
              />
              <p className="flex gap-2 text-xs text-muted-foreground">
                <UrlHintIcon
                  className={cn("mt-px size-3.5 shrink-0", signed ? "text-primary" : "text-warning")}
                  aria-hidden
                />
                <span>
                  {t.rich(signed ? "urlHintSigned" : "urlHint", {
                    payload: "{{payload}}",
                    code: (chunks) => <code className="font-mono text-foreground">{chunks}</code>,
                  })}
                </span>
              </p>
            </Field>
            <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-muted/30 dark:bg-input/10">
              <div className="flex items-center justify-between gap-3 border-b bg-muted/40 py-1.5 pr-1.5 pl-3">
                <span className="text-xs font-medium text-muted-foreground">{t("curlExample")}</span>
                <Button variant="ghost" size="xs" onClick={() => copy("curl", curl)}>
                  {copied === "curl" ? <CheckIcon /> : <CopyIcon />}
                  {copied === "curl" ? tCommon("actions.copied") : tCommon("actions.copy")}
                </Button>
              </div>
              <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{curl}</pre>
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                {t.rich("response", {
                  example: EXAMPLE_RESPONSE,
                  limit: trigger?.rateLimitPerMinute ?? WEBHOOK_RATE_LIMIT.requests,
                  code: (chunks) => <code className="font-mono text-foreground">{chunks}</code>,
                })}
              </p>
            </div>
            {trigger && (
              <WebhookSigning key={trigger.id} triggerId={trigger.id} signed={signed} onSignedChange={setSignedNow} />
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noToken")}</p>
        )}
        <DialogFooter className={stickyFooterClass}>
          {current ? (
            <ConfirmButton
              icon={RefreshCwIcon}
              label={t("regenerate")}
              title={t("regenerateTitle")}
              description={t("regenerateDescription")}
              confirm={t("regenerateConfirm")}
              pending={pending}
              size="default"
              className="-ml-2 text-muted-foreground"
              onConfirm={() =>
                startTransition(async () => {
                  if (!trigger) return;
                  const res = await regenerateTriggerToken({ id: trigger.id });
                  if (!res.ok) return void toast.error(res.error);
                  setToken(res.data.token);
                  toast.success(t("regenerated"));
                })
              }
            />
          ) : (
            <span />
          )}
          <DialogClose asChild>
            <Button>{t("done")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether the trigger requires signed requests, with the actions to require, rotate or stop
 * requiring them. A new secret is shown here once, until the dialog closes.
 */
function WebhookSigning({
  triggerId,
  signed,
  onSignedChange,
}: {
  triggerId: string;
  signed: boolean;
  onSignedChange: (signed: boolean) => void;
}) {
  const t = useTranslations("automations.webhook.signing");
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { copied, copy } = useCopy();
  const code = (chunks: React.ReactNode) => <code className="font-mono text-foreground">{chunks}</code>;
  const strong = (chunks: React.ReactNode) => <strong className="font-medium text-foreground">{chunks}</strong>;

  const createSecret = (message: string) =>
    startTransition(async () => {
      const res = await createTriggerSigningSecret({ id: triggerId });
      if (!res.ok) return void toast.error(res.error);
      onSignedChange(true);
      setSecret(res.data.secret);
      toast.success(message);
    });

  const removeSecret = () =>
    startTransition(async () => {
      const res = await deleteTriggerSigningSecret({ id: triggerId });
      if (!res.ok) return void toast.error(res.error);
      onSignedChange(false);
      setSecret(null);
      toast.success(t("removed"));
    });

  const Icon = signed ? ShieldCheckIcon : ShieldIcon;
  return (
    <section aria-labelledby="webhook-signing-title" className="flex min-w-0 flex-col gap-4 border-t border-border/70 pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            signed ? "bg-primary/8 text-primary dark:bg-primary/15" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <h3 id="webhook-signing-title" className="text-sm font-semibold">
            {t("title")}
          </h3>
          <p className="text-xs text-pretty text-muted-foreground">{signed ? t("on") : t("off")}</p>
        </div>
        {signed ? (
          <div className="flex gap-1">
            <ConfirmButton
              icon={RefreshCwIcon}
              label={t("rotate")}
              title={t("rotateTitle")}
              description={t("rotateDescription")}
              confirm={t("rotateConfirm")}
              pending={pending}
              onConfirm={() => createSecret(t("rotated"))}
            />
            <ConfirmButton
              icon={ShieldOffIcon}
              label={t("remove")}
              title={t("removeTitle")}
              description={t("removeDescription")}
              confirm={t("removeConfirm")}
              pending={pending}
              destructive
              className="text-muted-foreground hover:text-destructive"
              onConfirm={removeSecret}
            />
          </div>
        ) : (
          <ConfirmButton
            icon={ShieldCheckIcon}
            label={t("enable")}
            title={t("enableTitle")}
            description={t("enableDescription")}
            confirm={t("enableConfirm")}
            pending={pending}
            variant="outline"
            onConfirm={() => createSecret(t("created"))}
          />
        )}
      </div>

      {secret && (
        <Field>
          <FieldLabel htmlFor="webhook-signing-secret">{t("secret")}</FieldLabel>
          <CopyField
            id="webhook-signing-secret"
            value={secret}
            copied={copied === "secret"}
            onCopy={() => copy("secret", secret)}
          />
          <FieldDescription className="flex gap-2 text-xs">
            <ShieldAlertIcon className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <span>{t("secretOnce")}</span>
          </FieldDescription>
        </Field>
      )}

      {signed && (
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted-foreground marker:text-border">
          <li>{t.rich("standardWebhooks", { minutes: WEBHOOK_SIGNATURE_TOLERANCE_SECONDS / 60, code, strong })}</li>
          <li>{t.rich("github", { code, strong })}</li>
        </ul>
      )}
    </section>
  );
}
