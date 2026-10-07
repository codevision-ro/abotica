"use client";

import type { AgentAvatar } from "@abotica/db/avatar";
import { eventKey, TRIGGER_EVENTS, type TriggerEvent, usesWebhook } from "@abotica/core/trigger-events";
import {
  CircleCheckIcon,
  type LucideIcon,
  MailIcon,
  PlusIcon,
  SaveIcon,
  SquarePlusIcon,
  WebhookIcon,
  ZapIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { OptionCards } from "@/components/app/option-cards";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createTrigger, updateTrigger } from "@/server/actions/automations";
import { DialogActiveSwitch, DialogGroup, DialogHeading, stickyFooterClass } from "./dialog-parts";
import { AgentSelect, ProjectSelect } from "./option-selects";

type Option = { id: string; name: string; avatar?: AgentAvatar | null };

export type TriggerDraft = {
  id?: string;
  name: string;
  agentId: string;
  projectId: string | null;
  event: string;
  prompt: string;
  enabled: boolean;
};

/** Icon of each trigger event, shared by the event picker and the trigger cards. */
export const EVENT_ICONS: Record<(typeof TRIGGER_EVENTS)[number]["key"], LucideIcon> = {
  webhook: WebhookIcon,
  taskCreated: SquarePlusIcon,
  taskDone: CircleCheckIcon,
  emailReceived: MailIcon,
};

/** Literal placeholder replaced with the event data; passed into messages as a value. */
const PAYLOAD = "{{payload}}";

export function TriggerDialog({
  open,
  onOpenChange,
  initial,
  agents,
  projects,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: TriggerDraft;
  agents: Option[];
  projects: Option[];
  onSaved: (saved: { id: string; name: string; event: string; token: string | null }, created: boolean) => void;
}) {
  const edited = useRef(false);
  useEffect(() => {
    if (open) edited.current = false;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        // A stray tap next to the dialog must not throw away typed text; Escape and the close button still work.
        onInteractOutside={(e) => edited.current && e.preventDefault()}
      >
        {open && (
          <TriggerForm
            initial={initial}
            agents={agents}
            projects={projects}
            onEdit={() => (edited.current = true)}
            onSaved={(saved, created) => {
              onOpenChange(false);
              onSaved(saved, created);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TriggerForm({
  initial,
  agents,
  projects,
  onEdit,
  onSaved,
}: {
  initial: TriggerDraft;
  agents: Option[];
  projects: Option[];
  onEdit: () => void;
  onSaved: (saved: { id: string; name: string; event: string; token: string | null }, created: boolean) => void;
}) {
  const t = useTranslations("automations.triggerDialog");
  const tf = useTranslations("automations.fields");
  const te = useTranslations("automations.events");
  const th = useTranslations("automations.eventHints");
  const tCommon = useTranslations("common");
  const [name, setName] = useState(initial.name);
  const [agentId, setAgentId] = useState(initial.agentId);
  const [projectId, setProjectId] = useState(initial.projectId);
  const [event, setEvent] = useState<TriggerEvent>((initial.event as TriggerEvent) || "webhook");
  const [prompt, setPrompt] = useState(initial.prompt);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const input = { name, agentId, projectId, event, prompt, enabled };
      const res = initial.id ? await updateTrigger({ ...input, id: initial.id }) : await createTrigger(input);
      if (!res.ok) return void toast.error(res.error);
      toast.success(initial.id ? t("updated") : t("created"));
      onSaved({ id: res.data.id, name, event, token: res.data.token }, !initial.id);
    });
  };

  return (
    <form onSubmit={submit} onInput={onEdit} className="flex min-w-0 flex-col gap-5">
      <DialogHeading icon={ZapIcon} title={initial.id ? t("editTitle") : t("createTitle")} description={t("description")} />

      <DialogGroup>
        <Field>
          <FieldLabel htmlFor="trigger-name">{tf("name")}</FieldLabel>
          <Input
            id="trigger-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            required
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="trigger-agent">{tf("agent")}</FieldLabel>
            <AgentSelect id="trigger-agent" value={agentId} onChange={setAgentId} agents={agents} />
          </Field>
          <Field>
            <FieldLabel htmlFor="trigger-project">{tf("projectOptional")}</FieldLabel>
            <ProjectSelect id="trigger-project" value={projectId} onChange={setProjectId} projects={projects} />
          </Field>
        </div>
      </DialogGroup>

      <DialogGroup title={t("event")}>
        <OptionCards
          name="trigger-event"
          label={t("event")}
          value={event}
          onValueChange={setEvent}
          options={TRIGGER_EVENTS.map((e) => ({
            value: e.value,
            icon: EVENT_ICONS[e.key],
            title: te(e.key),
            description: th(e.key),
          }))}
        />
        {usesWebhook(event) && (
          <p className="-mt-1 text-xs text-muted-foreground">{initial.id ? t("webhookHintKeep") : t("webhookHint")}</p>
        )}
      </DialogGroup>

      <DialogGroup title={tf("prompt")}>
        <Field>
          <Textarea
            id="trigger-prompt"
            aria-label={tf("prompt")}
            aria-describedby="trigger-prompt-help"
            rows={6}
            className="max-h-72"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("promptPlaceholder", { payload: PAYLOAD })}
            required
          />
          <FieldDescription id="trigger-prompt-help">
            {t(`payloadHelp.${eventKey(event) ?? "webhook"}`, { payload: PAYLOAD })}{" "}
            {usesWebhook(event) ? t("payloadAppended", { payload: PAYLOAD }) : t("projectFilter")}
          </FieldDescription>
        </Field>
      </DialogGroup>

      <DialogFooter className={stickyFooterClass}>
        <DialogActiveSwitch id="trigger-enabled" label={tf("active")} checked={enabled} onCheckedChange={setEnabled} />
        <Button type="submit" disabled={pending || !name.trim() || !agentId || !prompt.trim()}>
          {pending ? <Spinner /> : initial.id ? <SaveIcon /> : <PlusIcon />}
          {initial.id ? tCommon("actions.save") : t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
