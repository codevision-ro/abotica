"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { decideApproval } from "@/server/actions/approvals";

export function ApprovalActions({
  id,
  size = "sm",
  approveVariant = "default",
}: {
  id: string;
  size?: "sm" | "xs";
  /** "outline" for lists with several requests, so the view keeps a single filled button. */
  approveVariant?: "default" | "outline";
}) {
  const t = useTranslations("approvals.actions");
  const tc = useTranslations("common.actions");
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<boolean | null>(null);
  const reasonId = useId();

  const decide = (approved: boolean) => {
    setChoice(approved);
    start(async () => {
      const res = await decideApproval({ id, approved, reason: approved ? undefined : reason.trim() || undefined });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setOpen(false);
      toast.success(
        approved
          ? res.data.continued
            ? t("approvedContinued")
            : t("approved")
          : res.data.continued
            ? t("rejectedNotified")
            : t("rejected"),
      );
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size={size} disabled={pending}>
            {pending && choice === false ? <Spinner /> : <X />}
            {tc("reject")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              decide(false);
            }}
          >
            <Field>
              <FieldLabel htmlFor={reasonId}>{t("reasonLabel")}</FieldLabel>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("reasonPlaceholder")}
                rows={3}
                autoFocus
              />
            </Field>
            <Button type="submit" variant="destructive" size="sm" disabled={pending}>
              {pending && choice === false && <Spinner />}
              {t("submitReject")}
            </Button>
          </form>
        </PopoverContent>
      </Popover>
      <Button variant={approveVariant} size={size} disabled={pending} onClick={() => decide(true)}>
        {pending && choice === true ? <Spinner /> : <Check />}
        {tc("approve")}
      </Button>
    </div>
  );
}
