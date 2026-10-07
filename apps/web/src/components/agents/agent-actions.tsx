"use client";

import { CopyIcon, EllipsisIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { deleteAgent, duplicateAgent, restoreAgentVersion, setAgentEnabled } from "@/server/actions/agents";

export function AgentEnabledSwitch({
  id,
  enabled,
  locked = false,
  withLabel = false,
}: {
  id: string;
  enabled: boolean;
  locked?: boolean;
  withLabel?: boolean;
}) {
  const t = useTranslations("agents.actions");
  const [value, setValue] = useState(enabled);
  const [pending, startTransition] = useTransition();
  const label = value ? t("active") : t("disabled");
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <Switch
        checked={value}
        disabled={locked || pending}
        title={locked ? t("orchestratorLocked") : undefined}
        aria-label={locked ? t("orchestratorLocked") : value ? t("disable") : t("enable")}
        onCheckedChange={(next) => {
          setValue(next);
          startTransition(async () => {
            const res = await setAgentEnabled({ id, enabled: next });
            if (!res.ok) {
              setValue(!next);
              toast.error(res.error);
            } else toast.success(next ? t("enabledToast") : t("disabledToast"));
          });
        }}
      />
      {withLabel && label}
    </label>
  );
}

/** Secondary actions of an agent, behind one "more" button so the header keeps a single primary action. */
export function AgentActions({ id, name, isOrchestrator }: { id: string; name: string; isOrchestrator: boolean }) {
  const t = useTranslations("agents.actions");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  function duplicate() {
    startTransition(async () => {
      const res = await duplicateAgent({ id });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("duplicated"));
      router.push(`/agents/${res.data.id}`);
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteAgent({ id });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("deleted"));
      router.push("/agents");
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" disabled={pending} aria-label={t("more")} title={t("more")}>
            {pending ? <Spinner /> : <EllipsisIcon />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={duplicate}>
            <CopyIcon /> {t("duplicate")}
          </DropdownMenuItem>
          {!isOrchestrator && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2Icon /> {tc("delete")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {!isOrchestrator && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("deleteTitle", { name })}
          description={t("deleteDescription")}
          titleClassName="wrap-anywhere"
          confirm={tc("delete")}
          destructive
          onConfirm={remove}
        />
      )}
    </>
  );
}

export function RestoreVersionButton({ id, version }: { id: string; version: number }) {
  const t = useTranslations("agents.actions");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={pending}>
          {pending && <Spinner />} {t("restore")}
        </Button>
      }
      title={t("restoreTitle", { version })}
      description={t("restoreDescription", { version })}
      confirm={t("restore")}
      onConfirm={() =>
        startTransition(async () => {
          const res = await restoreAgentVersion({ id, version });
          if (!res.ok) return void toast.error(res.error);
          toast.success(t("restored", { version: res.data.version }));
          router.push(`/agents/${id}?tab=versions`);
        })
      }
    />
  );
}
