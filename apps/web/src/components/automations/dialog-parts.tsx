"use client";

import type { LucideIcon } from "lucide-react";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

/** Dialog header with a tinted icon tile, vertically centered with the title and description. */
export function DialogHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  description: React.ReactNode;
}) {
  return (
    <DialogHeader className="flex-row items-center gap-3 pr-8">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary dark:bg-primary/15">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <DialogTitle className="text-base leading-snug font-semibold tracking-tight wrap-anywhere">{title}</DialogTitle>
        <DialogDescription className="text-pretty">{description}</DialogDescription>
      </div>
    </DialogHeader>
  );
}

/** Footer that stays in view while a long dialog scrolls (e.g. on phones); opaque so fields pass under it. */
export const stickyFooterClass =
  "sticky -bottom-4 z-10 flex-row items-center justify-between bg-[color-mix(in_oklch,var(--muted)_50%,var(--popover))]";

/** A titled group of fields inside a dialog, set off from the header or the group above by a hairline. */
export function DialogGroup({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 border-border/70 not-first:border-t not-first:pt-5">
      {title && <h3 className="-mb-1 text-sm font-semibold">{title}</h3>}
      {children}
    </div>
  );
}

/** The "active" switch on the left of a dialog footer, next to the primary action. */
export function DialogActiveSwitch({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm font-medium sm:mr-auto">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      {label}
    </label>
  );
}
