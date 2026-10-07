"use client";

import type { AgentAvatar } from "@abotica/db/avatar";
import { eventKey, usesWebhook } from "@abotica/core/trigger-events";
import { Link2Icon, PencilIcon, PlusIcon, ZapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDelete } from "@/components/app/confirm-dialog";
import { sectionCardClass } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { deleteTrigger, setTriggerEnabled } from "@/server/actions/automations";
import { AutomationCard, AutomationDetail, AutomationPrompt, automationGridClass } from "./automation-card";
import { EVENT_ICONS, TriggerDialog, type TriggerDraft } from "./trigger-dialog";
import { WebhookDialog, type WebhookTarget } from "./webhook-dialog";

type Option = { id: string; name: string; avatar?: AgentAvatar | null };

type TriggerItem = TriggerDraft & {
  id: string;
  token: string | null;
  signed: boolean;
  agentName: string;
  agentAvatar: AgentAvatar | null;
  projectName: string | null;
};

export function TriggersSection({
  triggers,
  agents,
  projects,
  appUrl,
  toolbar,
}: {
  triggers: TriggerItem[];
  agents: Option[];
  projects: Option[];
  appUrl: string;
  /** Shown left of the "New trigger" button, e.g. the page's tabs. */
  toolbar?: React.ReactNode;
}) {
  const t = useTranslations("automations.triggers");
  const blank: TriggerDraft = {
    name: "",
    agentId: agents[0]?.id ?? "",
    projectId: null,
    event: "webhook",
    prompt: "",
    enabled: true,
  };
  const [dialog, setDialog] = useState<{ open: boolean; draft: TriggerDraft }>({ open: false, draft: blank });
  const [webhook, setWebhook] = useState<{ open: boolean; target: WebhookTarget | null }>({ open: false, target: null });
  const openNew = () => setDialog({ open: true, draft: blank });
  const newButton = (
    <Button onClick={openNew} disabled={!agents.length}>
      <PlusIcon /> {t("new")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {toolbar}
        <div className="ml-auto">{newButton}</div>
      </div>
      {triggers.length ? (
        <div className={automationGridClass}>
          {triggers.map((tr) => (
            <TriggerCard
              key={tr.id}
              t={tr}
              onEdit={() => setDialog({ open: true, draft: tr })}
              onWebhook={() => setWebhook({ open: true, target: tr })}
            />
          ))}
        </div>
      ) : (
        <p className={cn(sectionCardClass, "px-4 py-4 text-sm text-muted-foreground sm:px-5")}>{t("empty")}</p>
      )}
      <TriggerDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initial={dialog.draft}
        agents={agents}
        projects={projects}
        onSaved={(saved, created) => {
          if (created && saved.token) setWebhook({ open: true, target: { ...saved, signed: false } });
        }}
      />
      <WebhookDialog
        open={webhook.open}
        onOpenChange={(open) => setWebhook((w) => ({ ...w, open }))}
        trigger={webhook.target}
        appUrl={appUrl}
      />
    </div>
  );
}

function TriggerSwitch({ t: trigger }: { t: TriggerItem }) {
  const t = useTranslations("automations.triggers");
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={trigger.enabled}
      disabled={pending}
      aria-label={trigger.enabled ? t("disable") : t("enable")}
      onCheckedChange={(enabled) =>
        startTransition(async () => {
          const res = await setTriggerEnabled({ id: trigger.id, enabled });
          if (!res.ok) toast.error(res.error);
        })
      }
    />
  );
}

function TriggerActions({ t: trigger, onEdit }: { t: TriggerItem; onEdit: () => void }) {
  const t = useTranslations("automations.triggers");
  return (
    <div className="relative z-10 ml-auto flex gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("edit")} onClick={onEdit}>
            <PencilIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("edit")}</TooltipContent>
      </Tooltip>
      <ConfirmDelete
        label={t("delete")}
        title={t("deleteTitle")}
        description={
          usesWebhook(trigger.event)
            ? t("deleteDescriptionWebhook", { name: trigger.name })
            : t("deleteDescription", { name: trigger.name })
        }
        onConfirm={async () => {
          const res = await deleteTrigger({ id: trigger.id });
          if (res.ok) toast.success(t("deleted"));
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

type CardProps = { t: TriggerItem; onEdit: () => void; onWebhook: () => void };

function TriggerCard({ t: trigger, onEdit, onWebhook }: CardProps) {
  const t = useTranslations("automations.triggers");
  const te = useTranslations("automations.events");
  const th = useTranslations("automations.eventHints");
  const key = eventKey(trigger.event);
  const webhook = usesWebhook(trigger.event);
  return (
    <AutomationCard
      name={trigger.name}
      agentName={trigger.agentName}
      agentAvatar={trigger.agentAvatar}
      projectName={trigger.projectName}
      enabled={trigger.enabled}
      editLabel={t("edit")}
      onEdit={onEdit}
      toggle={<TriggerSwitch t={trigger} />}
      footer={
        <>
          {webhook && (
            <Button variant="outline" size="sm" className="relative z-10" onClick={onWebhook}>
              <Link2Icon /> {t("url")}
            </Button>
          )}
          <TriggerActions t={trigger} onEdit={onEdit} />
        </>
      }
    >
      <AutomationDetail
        icon={key ? EVENT_ICONS[key] : ZapIcon}
        title={key ? te(key) : trigger.event}
        meta={key ? th(key) : undefined}
      />
      <AutomationPrompt prompt={trigger.prompt} />
    </AutomationCard>
  );
}
