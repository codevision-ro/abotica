"use client";

import { inheritedEffort } from "@abotica/core/models/reasoning";
import { BotIcon, BrainIcon, ChevronDownIcon, CpuIcon, RotateCcwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { ReasoningEffortControl } from "@/components/agents/reasoning-effort-control";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import { setConversationModel } from "@/server/actions/chat";
import type { ChatModelOption, ChatModelState } from "@/server/queries/chat";

type ModelRef = { provider: string; model: string };
type Selection = ChatModelState["selection"];

const AGENT_VALUE = "agent";
const keyOf = (m: ModelRef) => `${m.provider}/${m.model}`;
const sameModel = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  Boolean(a && b && a.provider === b.provider && a.model === b.model);
/** "Claude Sonnet 4.5 (latest)" reads as "Claude Sonnet 4.5" in tight places. */
const displayName = (name: string) => name.replace(/\s*\(latest\)\s*$/i, "");

/** What the conversation runs on: its own choice or the agent's, with what is known about that model. */
function effectiveModel(state: ChatModelState, selection: Selection) {
  const ref = selection.model ?? state.agent.model;
  const option = ref
    ? state.providers.find((p) => p.id === ref.provider)?.models.find((m) => m.id === ref.model)
    : undefined;
  const fromAgent = sameModel(ref, state.agent.model) ? state.agent.model : null;
  const effort = inheritedEffort(selection.reasoningEffort, state.agent.reasoningEffort, state.defaultReasoningEffort);
  return {
    ref,
    name: displayName(option?.name ?? fromAgent?.name ?? ref?.model ?? ""),
    // Undefined for unknown models (custom ids): they may reason, so every effort stays on offer.
    support: option ? option.reasoning : fromAgent?.reasoning,
    effort,
    overridden: selection.model !== null || selection.reasoningEffort !== null,
  };
}

/** The conversation's model choice with optimistic updates; a failed save rolls back and toasts. */
export function useChatModel(conversationId: string, state: ChatModelState) {
  const [selection, setOptimistic] = useOptimistic(state.selection);
  const [, startTransition] = useTransition();

  function save(next: Selection) {
    // The agent's own model means "follow the agent", as the server stores it. The effort has its own switch.
    const normalized: Selection = {
      model: next.model && !sameModel(next.model, state.agent.model) ? next.model : null,
      reasoningEffort: next.reasoningEffort,
    };
    startTransition(async () => {
      setOptimistic(normalized);
      const res = await setConversationModel({ conversationId, ...normalized });
      if (!res.ok) toast.error(res.error);
    });
  }

  return { selection, save, effective: effectiveModel(state, selection) };
}

/** Small dot marking a choice that differs from the agent's. */
export function OverrideDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-primary", className)} />;
}

type PickerProps = {
  state: ChatModelState;
  selection: Selection;
  effective: ReturnType<typeof effectiveModel>;
  onChange: (next: Selection) => void;
  /** The agent is answering: the change applies from the next message. */
  busy: boolean;
};

/** Chat header control: shows the conversation's model and opens the picker (popover on desktop, drawer on mobile). */
export function ChatModelPicker(props: PickerProps) {
  const { effective } = props;
  const t = useTranslations("chat.model");
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const label = effective.name || t("noAgentModel");
  // While searching on a phone the keyboard takes half the screen: give it all to the results.
  const searching = isMobile && query.trim() !== "";
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const body = <PickerBody {...props} query={query} onQueryChange={setQuery} mobile={isMobile} hideEffort={searching} />;
  const showEffort = effective.support !== null && effective.effort !== "default";

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      aria-label={t("trigger", { model: label })}
      title={effective.ref ? keyOf(effective.ref) : undefined}
      className="h-8 max-w-[min(17rem,38vw)] min-w-0 shrink gap-1.5 rounded-full border-border/70 bg-card/70 px-3 text-[13px] font-normal text-muted-foreground shadow-none hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-card/40"
    >
      {effective.overridden ? <OverrideDot /> : <CpuIcon className="hidden size-3.5 shrink-0 opacity-70 sm:block" />}
      <span className="min-w-0 truncate">{label}</span>
      {showEffort && (
        <span className="hidden shrink-0 items-center gap-0.5 text-muted-foreground/80 sm:inline-flex">
          <BrainIcon className="size-3" />
          {t(`effort.options.${effective.effort}`)}
        </span>
      )}
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
    </Button>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        {/* Focus the sheet, not the search: that would pop up the on-screen keyboard. */}
        <DrawerContent
          className="max-h-[88svh] outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <DrawerHeader className="gap-1 px-4 pt-3 pb-2">
            <DrawerTitle>{t("title")}</DrawerTitle>
            <DrawerDescription className={cn("text-xs", searching && "sr-only")}>{t("description")}</DrawerDescription>
          </DrawerHeader>
          {body}
          <DrawerFooter className="flex-row gap-2 border-t px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {effective.overridden && <ResetButton {...props} className="flex-1" />}
            <DrawerClose asChild>
              <Button variant="outline" className="flex-1">
                {t("close")}
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className="w-[27rem] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0"
      >
        <div className="border-b px-3.5 pt-3 pb-2.5">
          <div className="text-sm font-medium">{t("title")}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        {body}
        {effective.overridden && (
          <div className="border-t p-1.5">
            <ResetButton {...props} className="w-full justify-start" variant="ghost" />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ResetButton({
  onChange,
  className,
  variant = "outline",
}: PickerProps & { className?: string; variant?: "outline" | "ghost" }) {
  const t = useTranslations("chat.model");
  return (
    <Button variant={variant} className={className} onClick={() => onChange({ model: null, reasoningEffort: null })}>
      <RotateCcwIcon />
      {t("reset")}
    </Button>
  );
}

function PickerBody({
  state,
  selection,
  effective,
  onChange,
  busy,
  query,
  onQueryChange,
  mobile,
  hideEffort,
}: PickerProps & { query: string; onQueryChange: (query: string) => void; mobile: boolean; hideEffort: boolean }) {
  const t = useTranslations("chat.model");
  const agentModel = state.agent.model;
  const current = selection.model ? keyOf(selection.model) : AGENT_VALUE;
  // A chosen model that is no longer offered (provider key removed, custom id) still shows as selected.
  const missing =
    selection.model &&
    !state.providers.some(
      (p) => p.id === selection.model!.provider && p.models.some((m) => m.id === selection.model!.model),
    )
      ? selection.model
      : null;
  const pick = (model: ModelRef | null) => onChange({ ...selection, model });

  return (
    <>
      <Command defaultValue={current} label={t("title")} className="min-h-0 flex-1 rounded-none! bg-transparent">
        <CommandInput
          placeholder={t("search")}
          value={query}
          onValueChange={onQueryChange}
          className={cn(mobile && "text-base")}
        />
        <CommandList className={cn(mobile ? "max-h-none min-h-0 flex-1" : "max-h-[min(22rem,45svh)]")}>
          <CommandEmpty>{t("empty")}</CommandEmpty>
          <CommandGroup>
            <CommandItem
              value={AGENT_VALUE}
              keywords={[t("agentModel"), agentModel?.name ?? "", agentModel?.model ?? ""]}
              onSelect={() => pick(null)}
              data-checked={!selection.model}
              className={cn("gap-2.5", mobile && "py-2.5")}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <BotIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{t("agentModel")}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {agentModel ? displayName(agentModel.name) : t("noAgentModel")}
                  {agentModel && state.agent.followsDefault && ` · ${t("fromSettings")}`}
                </span>
              </span>
            </CommandItem>
          </CommandGroup>
          {missing && (
            <CommandGroup heading={missing.provider}>
              <ModelItem
                provider={missing.provider}
                model={{ id: missing.model, name: missing.model, reasoning: null, contextWindow: null, cost: null }}
                selected
                onSelect={() => pick(missing)}
                mobile={mobile}
              />
            </CommandGroup>
          )}
          {state.providers.map((provider) => (
            <CommandGroup key={provider.id} heading={provider.label}>
              {provider.models.map((m) => (
                <ModelItem
                  key={m.id}
                  provider={provider.id}
                  providerLabel={provider.label}
                  model={m}
                  selected={sameModel(selection.model, { provider: provider.id, model: m.id })}
                  isAgent={sameModel(agentModel, { provider: provider.id, model: m.id })}
                  onSelect={() => pick({ provider: provider.id, model: m.id })}
                  mobile={mobile}
                />
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      {!hideEffort && (
        <>
          <SeparatorLine />
          <EffortSection state={state} selection={selection} effective={effective} onChange={onChange} busy={busy} />
        </>
      )}
    </>
  );
}

/** A plain separator: CommandSeparator hides itself while searching, this one stays. */
function SeparatorLine() {
  return <div role="separator" className="h-px shrink-0 bg-border" />;
}

function ModelItem({
  provider,
  providerLabel,
  model,
  selected,
  isAgent,
  onSelect,
  mobile,
}: {
  provider: string;
  providerLabel?: string;
  model: ChatModelOption;
  selected: boolean;
  isAgent?: boolean;
  onSelect: () => void;
  mobile?: boolean;
}) {
  const t = useTranslations("chat.model");
  const format = useFormat();
  return (
    <CommandItem
      value={`${provider}/${model.id}`}
      keywords={[model.name, providerLabel ?? provider]}
      onSelect={onSelect}
      data-checked={selected}
      className={cn("items-start gap-2 [&>svg:last-child]:mt-0.5", mobile && "py-2.5")}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{displayName(model.name)}</span>
          {isAgent && (
            <span className="shrink-0 rounded-sm bg-primary/10 px-1 py-px text-[10px] leading-3.5 font-medium text-primary">
              {t("agentTag")}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate font-mono">{model.id}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {model.reasoning && (
              <Meta title={t("reasoning")}>
                <BrainIcon className="size-3" />
                <span className="sr-only">{t("reasoning")}</span>
              </Meta>
            )}
            {model.contextWindow && (
              <Meta title={t("context", { size: format.tokens(model.contextWindow) })}>
                {format.tokens(model.contextWindow)}
              </Meta>
            )}
            <Meta
              title={
                model.cost
                  ? t("price", { input: format.modelPrice(model.cost.input), output: format.modelPrice(model.cost.output) })
                  : t("unknownPrice")
              }
            >
              <span className="tabular">
                {model.cost ? `${format.modelPrice(model.cost.input)} / ${format.modelPrice(model.cost.output)}` : "?"}
              </span>
            </Meta>
          </span>
        </span>
      </span>
    </CommandItem>
  );
}

function Meta({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className="inline-flex h-4.5 items-center gap-1 rounded-sm bg-muted px-1 text-[10.5px] leading-none text-muted-foreground group-data-selected/command-item:bg-background"
    >
      {children}
    </span>
  );
}

function EffortSection({ state, selection, effective, onChange, busy }: PickerProps) {
  const t = useTranslations("chat.model");
  const te = useTranslations("agents.effort");
  const fromAgent = state.agent.reasoningEffort !== "default";
  return (
    <ReasoningEffortControl
      value={selection.reasoningEffort}
      onChange={(reasoningEffort) => onChange({ ...selection, reasoningEffort })}
      support={effective.support}
      modelName={effective.name}
      inherited={{
        effort: inheritedEffort(state.agent.reasoningEffort, state.defaultReasoningEffort),
        source: te(fromAgent ? "sources.agent" : "sources.settings"),
      }}
      size="sm"
      className="shrink-0 px-3.5 pt-3 pb-3"
    >
      {busy && <p className="text-[11px] leading-snug text-foreground/80">{t("busyHint")}</p>}
    </ReasoningEffortControl>
  );
}
