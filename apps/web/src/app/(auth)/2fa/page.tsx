"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { AuthCard } from "../auth-card";
import { useAuthError } from "../use-auth-error";

export default function TwoFactorPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(true);
  const [useBackup, setUseBackup] = useState(false);
  const [pending, setPending] = useState(false);
  const t = useTranslations("auth.twoFactor");
  const errorMessage = useAuthError();

  async function verify(value: string) {
    setPending(true);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: value, trustDevice })
      : await authClient.twoFactor.verifyTotp({ code: value, trustDevice });
    setPending(false);
    if (error) {
      setCode("");
      return void toast.error(errorMessage(error, t("invalidCode")));
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <AuthCard title={t("title")} description={useBackup ? t("backupDescription") : t("totpDescription")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
      >
        <FieldGroup>
          {useBackup ? (
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="xxxxx-xxxxx" autoFocus />
          ) : (
            <InputOTP
              maxLength={6}
              value={code}
              onChange={setCode}
              onComplete={(v) => void verify(v)}
              autoFocus
              containerClassName="justify-center"
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }, (_, i) => (
                  <InputOTPSlot key={i} index={i} className="size-11 text-lg" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          )}
          <Field orientation="horizontal">
            <Checkbox id="trust" checked={trustDevice} onCheckedChange={(v) => setTrustDevice(v === true)} />
            <FieldLabel htmlFor="trust" className="font-normal">
              {t("trustDevice")}
            </FieldLabel>
          </Field>
          <Button type="submit" size="lg" disabled={pending || code.length < 6}>
            {pending && <Spinner />}
            {t("submit")}
          </Button>
          <Button type="button" variant="link" onClick={() => (setUseBackup(!useBackup), setCode(""))}>
            {useBackup ? t("useApp") : t("useBackup")}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
