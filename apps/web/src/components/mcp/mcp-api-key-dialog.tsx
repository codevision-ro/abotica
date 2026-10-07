"use client";

import { Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { SecretInput } from "@/components/settings/secret-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { setBuiltinMcpKey } from "@/server/actions/mcp";

/**
 * Sets, replaces or removes the optional API key of a bundled HTTP server. The key goes straight
 * to the vault; the stored value is never loaded back, so the field always starts empty.
 */
export function McpApiKeyDialog({
  serverId,
  name,
  secret,
  keySet,
  children,
}: {
  serverId: string;
  name: string;
  /** Vault secret the key is stored in. */
  secret: string;
  keySet: boolean;
  /** The trigger button. */
  children: React.ReactNode;
}) {
  const t = useTranslations("mcp.apiKey");
  const tc = useTranslations("common.actions");
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, startSave] = useTransition();
  const [removing, startRemove] = useTransition();
  const busy = saving || removing;

  function change(next: boolean) {
    setOpen(next);
    if (!next) setValue("");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // The dialog is portaled but still inside a form in the React tree: keep the submit to itself.
    e.stopPropagation();
    startSave(async () => {
      const res = await setBuiltinMcpKey({ id: serverId, value });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("saved"));
      change(false);
    });
  }

  function remove() {
    startRemove(async () => {
      const res = await setBuiltinMcpKey({ id: serverId, value: null });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("removed", { name }));
      change(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="wrap-anywhere">{t("dialogTitle", { name })}</DialogTitle>
            <DialogDescription>{t("dialogDescription", { secret })}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`mcp-key-${serverId}`}>{t("value")}</FieldLabel>
            <SecretInput
              id={`mcp-key-${serverId}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <DialogFooter className="sm:justify-between">
            {keySet ? (
              <Button
                type="button"
                variant="ghost"
                onClick={remove}
                disabled={busy}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {removing ? <Spinner /> : <Trash2Icon />} {t("remove")}
              </Button>
            ) : (
              <span aria-hidden className="hidden sm:block" />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={() => change(false)}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={busy || !value.trim()}>
                {saving && <Spinner />} {tc("save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
