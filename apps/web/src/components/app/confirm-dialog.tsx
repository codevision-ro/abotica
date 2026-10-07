"use client";

import { type LucideIcon, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Asks before an action: title, description, Cancel and the confirm button. Opens from `trigger`, or is
 * controlled with `open` when something else asks for it (e.g. a menu item).
 */
export function ConfirmDialog({
  trigger,
  tooltip,
  open,
  onOpenChange,
  icon: Icon,
  title,
  description,
  titleClassName,
  descriptionClassName,
  cancel,
  confirm,
  destructive = false,
  onConfirm,
}: {
  /** The button that opens the dialog. */
  trigger?: React.ReactNode;
  /** Tooltip on the trigger. */
  tooltip?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shown in a red tile next to the title. */
  icon?: LucideIcon;
  title: React.ReactNode;
  description: React.ReactNode;
  titleClassName?: string;
  descriptionClassName?: string;
  /** Label of the button that closes the dialog; "Cancel" by default. */
  cancel?: React.ReactNode;
  confirm: React.ReactNode;
  /** Red confirm button, for actions that remove or stop something. */
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations("common.actions");
  const opener = trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{opener}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        opener
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          {Icon && (
            <AlertDialogMedia className="size-10 rounded-xl bg-destructive/10 text-destructive dark:bg-destructive/15">
              <Icon className="size-5" />
            </AlertDialogMedia>
          )}
          <AlertDialogTitle className={titleClassName}>{title}</AlertDialogTitle>
          <AlertDialogDescription className={descriptionClassName}>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel ?? t("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Trash icon button of a list row, confirmed in a dialog. */
export function ConfirmDelete({
  title,
  description,
  label,
  onConfirm,
}: {
  title: string;
  description: string;
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations("common.actions");
  const [pending, startTransition] = useTransition();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={pending} className="hover:text-destructive">
          <Trash2 />
        </Button>
      }
      icon={Trash2}
      title={title}
      description={description}
      titleClassName="wrap-anywhere"
      descriptionClassName="wrap-anywhere"
      confirm={t("delete")}
      destructive
      onConfirm={() => startTransition(onConfirm)}
    />
  );
}

/** A secondary action that changes something the user cannot undo, asked again in a confirmation dialog. */
export function ConfirmButton({
  icon: Icon,
  label,
  title,
  description,
  confirm,
  pending,
  onConfirm,
  variant = "ghost",
  size = "sm",
  destructive = false,
  className,
  titleClassName,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  description: string;
  confirm: string;
  pending: boolean;
  onConfirm: () => void;
  variant?: "ghost" | "outline";
  size?: "sm" | "default";
  /** Red confirm button, for actions that remove something. */
  destructive?: boolean;
  className?: string;
  titleClassName?: string;
}) {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant={variant} size={size} disabled={pending} className={className}>
          {pending ? <Spinner /> : <Icon />} {label}
        </Button>
      }
      title={title}
      description={description}
      titleClassName={titleClassName}
      confirm={confirm}
      destructive={destructive}
      onConfirm={onConfirm}
    />
  );
}
