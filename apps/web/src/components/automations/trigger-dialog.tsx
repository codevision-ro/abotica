"use client";

import {
  eventKey,
  TRIGGER_EVENTS,
  type TriggerEvent,
  usesWebhook,
  WEBHOOK_RATE_LIMIT,
  WEBHOOK_RATE_LIMIT_BOUNDS,
} from "@abotica/core/trigger-events";
import {
  ChevronRightIcon,
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
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { OptionCards } from "@/components/app/option-cards";
import { SettingsNumberField } from "@/components/settings/settings-number-field";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createTrigger, updateTrigger } from "@/server/actions/automations";
import { DialogActiveSwitch, DialogGroup, DialogHeading, FormDialog, stickyFooterClass } from "./dialog-parts";
import { AgentSelect, type Option, ProjectSelect } from "./option-selects";

export type TriggerDraft = {
  id?: string;
  name: string;
  agentId: string;
  projectId: string | null;
  event: string;
  prompt: string;
  enabled: boolean;
  /** Webhook requests per minute; null uses the default. Missing when not known: saving keeps the stored one. */
  rateLimitPerMinute?: number | null;
};

type SavedTrigger = {
  id: string;
  name: string;
  event: string;
  token: string | null;
  rateLimitPerMinute: number | null;
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
  onSaved: (saved: SavedTrigger, created: boolean) => void;
}) {
  return (
    <FormDialog open={open} onOpenChange={onOpenChange}>
      <TriggerForm
        initial={initial}
        agents={agents}
        projects={projects}
        onSaved={(saved, created) => {
          onOpenChange(false);
          onSaved(saved, created);
        }}
      />
    </FormDialog>
  );
}

function TriggerForm({
  initial,
  agents,
  projects,
  onSaved,
}: {
  initial: TriggerDraft;
  agents: Option[];
  projects: Option[];
  onSaved: (saved: SavedTrigger, created: boolean) => void;
}) {
  const t = useTranslations("automations.triggerDialog");
  const tv = useTranslations("automations.validation");
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
  const [rateLimit, setRateLimit] = useState(initial.rateLimitPerMinute ?? null);
  const [advancedOpen, setAdvancedOpen] = useState(rateLimit !== null);
  const [pending, startTransition] = useTransition();
  const { min, max } = WEBHOOK_RATE_LIMIT_BOUNDS;
  const rateLimitError =
    rateLimit === null || (Number.isInteger(rateLimit) && rateLimit >= min && rateLimit <= max)
      ? undefined
      : tv("rateLimit", { min, max });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Unknown and left empty: nothing to send, so the stored limit stays.
    const limit = initial.rateLimitPerMinute !== undefined || rateLimit !== null ? rateLimit : undefined;
    startTransition(async () => {
      const input = { name, agentId, projectId, event, prompt, enabled, rateLimitPerMinute: limit };
      const res = initial.id ? await updateTrigger({ ...input, id: initial.id }) : await createTrigger(input);
      if (!res.ok) return void toast.error(res.error);
      toast.success(initial.id ? t("updated") : t("created"));
      onSaved(
        { id: res.data.id, name, event, token: res.data.token, rateLimitPerMinute: res.data.rateLimitPerMinute },
        !initial.id,
      );
    });
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-5">
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
          <>
            <p className="-mt-1 text-xs text-muted-foreground">{initial.id ? t("webhookHintKeep") : t("webhookHint")}</p>
            <Collapsible
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              className="group/advanced flex min-w-0 flex-col gap-3"
            >
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="-ml-2 self-start">
                  <ChevronRightIcon className="transition-transform group-data-[state=open]/advanced:rotate-90" />
                  {t("advanced")}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SettingsNumberField
                  id="trigger-rate-limit"
                  nullable
                  label={t("rateLimit")}
                  hint={t("rateLimitHint", { count: WEBHOOK_RATE_LIMIT.requests })}
                  value={rateLimit}
                  onChange={setRateLimit}
                  placeholder={String(WEBHOOK_RATE_LIMIT.requests)}
                  min={min}
                  max={max}
                  unit={t("perMinute")}
                  error={rateLimitError}
                />
              </CollapsibleContent>
            </Collapsible>
          </>
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
        <Button
          type="submit"
          disabled={
            pending || !name.trim() || !agentId || !prompt.trim() || (usesWebhook(event) && Boolean(rateLimitError))
          }
        >
          {pending ? <Spinner /> : initial.id ? <SaveIcon /> : <PlusIcon />}
          {initial.id ? tCommon("actions.save") : t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
