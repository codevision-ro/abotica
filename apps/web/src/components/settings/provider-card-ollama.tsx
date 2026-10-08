"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { setOllamaBaseUrl } from "@/server/actions/settings";
import type { ProviderStatus } from "@/server/queries/settings";

/** The address as the server stores it: an http(s) URL without its trailing slash; null when it is not one. */
function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** Where the Ollama server listens, as this machine sees it, and the models it has; saving lists them again. */
export function ProviderCardOllama({ provider, baseUrl }: { provider: ProviderStatus; baseUrl: string }) {
  const t = useTranslations("settings.providers");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [url, setUrl] = useState(baseUrl);
  const [saving, startSave] = useTransition();
  const normalized = normalizedUrl(url);
  const invalid = url.trim() !== "" && normalized === null;

  function save(e: React.FormEvent) {
    e.preventDefault();
    startSave(async () => {
      const res = await setOllamaBaseUrl({ url });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("ollamaUrlSaved", { count: res.data.models }));
      router.refresh();
    });
  }

  return (
    <>
      <form onSubmit={save}>
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor="ollama-url">{t("ollamaUrl")}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="ollama-url"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:11434"
              aria-invalid={invalid}
              className="font-mono"
            />
            <Button type="submit" variant="secondary" disabled={saving || !normalized || normalized === baseUrl}>
              {saving && <Spinner />} {tc("save")}
            </Button>
          </div>
          {invalid ? (
            <FieldError>{t("ollamaUrlInvalid")}</FieldError>
          ) : (
            <FieldDescription>{t("ollamaUrlHint")}</FieldDescription>
          )}
        </Field>
      </form>
      {provider.models.length ? (
        <div className="flex flex-wrap gap-1">
          {provider.models.map((m) => (
            <Badge key={m} variant="outline" className="max-w-full font-mono font-normal" title={m}>
              <span className="truncate">{m}</span>
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ollamaEmpty")}</p>
      )}
    </>
  );
}
