"use client";

import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { InlineSection } from "./inline-section";
import { useReturnFocus } from "./use-return-focus";

type PasswordIntent = "enable" | "disable" | "codes";
type Setup = { totpURI: string; secret: string; backupCodes: string[] };

function secretFromUri(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return /secret=([^&]+)/.exec(uri)?.[1] ?? "";
  }
}

export function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const t = useTranslations("settings.security");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [intent, setIntent] = useState<PasswordIntent | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  // The dialogs have no Radix trigger, so return focus to the button that opened them by hand.
  const { remember, restoreFocus } = useReturnFocus();
  function openIntent(next: PasswordIntent) {
    remember();
    setIntent(next);
  }

  function closePassword() {
    setIntent(null);
    setPassword("");
  }

  async function confirmPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!intent) return;
    setPending(true);
    try {
      if (intent === "enable") {
        const { data, error } = await authClient.twoFactor.enable({ password, method: "totp" });
        if (error || !data) return void toast.error(error?.message ?? t("wrongPassword"));
        if (!("totpURI" in data)) return void toast.error(t("noTotp"));
        setSetup({ totpURI: data.totpURI, secret: secretFromUri(data.totpURI), backupCodes: data.backupCodes });
        setCode("");
      } else if (intent === "disable") {
        const { error } = await authClient.twoFactor.disable({ password });
        if (error) return void toast.error(error.message ?? t("wrongPassword"));
        toast.success(t("twoFactorDisabled"));
        router.refresh();
      } else {
        const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
        if (error || !data) return void toast.error(error?.message ?? t("wrongPassword"));
        setNewCodes(data.backupCodes);
      }
      closePassword();
    } finally {
      setPending(false);
    }
  }

  async function verify(value: string) {
    setPending(true);
    const { error } = await authClient.twoFactor.verifyTotp({ code: value });
    setPending(false);
    if (error) {
      setCode("");
      return void toast.error(error.message ?? t("invalidCode"));
    }
    toast.success(t("twoFactorEnabled"));
    setSetup(null);
    router.refresh();
  }

  return (
    <>
      <InlineSection
        icon={enabled ? ShieldCheck : ShieldOff}
        title={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {t("twoFactorTitle")}
            {enabled ? (
              <Badge className="bg-success/10 font-normal text-success">
                <span aria-hidden className="size-1.5 rounded-full bg-current" /> {t("active")}
              </Badge>
            ) : (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {t("inactive")}
              </Badge>
            )}
          </span>
        }
        description={t("twoFactorDescription")}
      >
        {enabled ? (
          <>
            <Button variant="outline" onClick={() => openIntent("codes")}>
              <KeyRound /> {t("generateCodes")}
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => openIntent("disable")}
            >
              <ShieldOff /> {t("disable")}
            </Button>
          </>
        ) : (
          <Button onClick={() => openIntent("enable")}>
            <ShieldCheck /> {t("enable2fa")}
          </Button>
        )}
      </InlineSection>

      <Dialog open={intent !== null} onOpenChange={(open) => !open && closePassword()}>
        <DialogContent className="sm:max-w-md" onCloseAutoFocus={restoreFocus}>
          {intent && (
            <form onSubmit={confirmPassword} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>{t(`intent.${intent}.title`)}</DialogTitle>
                <DialogDescription>{t(`intent.${intent}.description`)}</DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="2fa-password">{t("password")}</FieldLabel>
                <Input
                  id="2fa-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  required
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closePassword}>
                  {tc("cancel")}
                </Button>
                <Button
                  type="submit"
                  variant={intent === "disable" ? "destructive" : "default"}
                  disabled={pending || !password}
                >
                  {pending && <Spinner />} {t(`intent.${intent}.cta`)}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={setup !== null} onOpenChange={(open) => !open && setSetup(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={restoreFocus}>
          {setup && (
            <div className="flex flex-col gap-5">
              <DialogHeader>
                <DialogTitle>{t("setupTitle")}</DialogTitle>
                <DialogDescription>{t("setupDescription")}</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG value={setup.totpURI} size={160} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className="text-xs font-medium text-muted-foreground">{t("manualKey")}</p>
                  <div className="flex items-center gap-1">
                    <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">
                      {setup.secret}
                    </code>
                    <CopyButton text={setup.secret} label={t("copyKey")} />
                  </div>
                </div>
              </div>
              <BackupCodes codes={setup.backupCodes} />
              <div className="flex flex-col items-center gap-3 border-t pt-4">
                <p className="text-sm font-medium">{t("appCode")}</p>
                <InputOTP
                  maxLength={6}
                  value={code}
                  onChange={setCode}
                  onComplete={(v) => void verify(v)}
                  disabled={pending}
                  autoFocus
                >
                  <InputOTPGroup>
                    {Array.from({ length: 6 }, (_, i) => (
                      <InputOTPSlot key={i} index={i} className="size-11 text-lg" />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
                <Button onClick={() => void verify(code)} disabled={pending || code.length < 6}>
                  {pending && <Spinner />} {t("verify")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={newCodes !== null} onOpenChange={(open) => !open && setNewCodes(null)}>
        <DialogContent className="sm:max-w-md" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{t("newCodesTitle")}</DialogTitle>
            <DialogDescription>{t("newCodesDescription")}</DialogDescription>
          </DialogHeader>
          {newCodes && <BackupCodes codes={newCodes} />}
          <DialogFooter>
            <Button onClick={() => setNewCodes(null)}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const t = useTranslations("settings.security");
  function download() {
    const blob = new Blob([`${t("codesFileHeader")}\n\n${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = t("codesFileName");
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t("backupCodes")}</p>
        <div className="flex gap-1">
          <CopyButton text={codes.join("\n")} label={t("copyCodes")} />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("downloadCodes")} onClick={download}>
            <Download />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-3 font-mono text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations("settings.security");
  const tc = useTranslations("common.actions");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => toast.success(tc("copied")),
          () => toast.error(t("copyFailed")),
        )
      }
    >
      <Copy />
    </Button>
  );
}
