"use client";

import type { AgentAvatar } from "@abotica/db/avatar";
import { eventKey, usesWebhook } from "@abotica/core/trigger-events";
import { Link2Icon, PencilIcon, ZapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDelete } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { deleteTrigger, setTriggerEnabled } from "@/server/actions/automations";
import {
  AutomationCard,
  AutomationDetail,
  AutomationList,
  AutomationPrompt,
  AutomationSwitch,
  IconAction,
} from "./automation-card";
import type { Option } from "./option-selects";
import { EVENT_ICONS, TriggerDialog, type TriggerDraft } from "./trigger-dialog";
import { WebhookDialog, type WebhookTarget } from "./webhook-dialog";

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

  return (
    <AutomationList
      toolbar={toolbar}
      newLabel={t("new")}
      onNew={() => setDialog({ open: true, draft: blank })}
      canCreate={agents.length > 0}
      empty={t("empty")}
      cards={triggers.map((tr) => (
        <TriggerCard
          key={tr.id}
          t={tr}
          onEdit={() => setDialog({ open: true, draft: tr })}
          onWebhook={() => setWebhook({ open: true, target: tr })}
        />
      ))}
    >
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
    </AutomationList>
  );
}

function TriggerActions({ t: trigger, onEdit }: { t: TriggerItem; onEdit: () => void }) {
  const t = useTranslations("automations.triggers");
  return (
    <div className="relative z-10 ml-auto flex gap-0.5">
      <IconAction label={t("edit")}>
        <Button variant="ghost" size="icon-sm" aria-label={t("edit")} onClick={onEdit}>
          <PencilIcon />
        </Button>
      </IconAction>
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

function TriggerCard({ t: trigger, onEdit, onWebhook }: { t: TriggerItem; onEdit: () => void; onWebhook: () => void }) {
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
      toggle={
        <AutomationSwitch
          checked={trigger.enabled}
          label={trigger.enabled ? t("disable") : t("enable")}
          save={(enabled) => setTriggerEnabled({ id: trigger.id, enabled })}
        />
      }
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
