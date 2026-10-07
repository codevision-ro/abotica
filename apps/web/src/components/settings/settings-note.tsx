import { Info } from "lucide-react";

/** A quiet informational note at the end of a settings page; no card, so it does not compete with the sections. */
export function SettingsNote({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <aside className="flex items-start gap-3 rounded-2xl border border-dashed border-border/80 px-4 py-3 text-sm sm:px-5">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{title}</p>
        <p className="text-pretty text-muted-foreground">{children}</p>
      </div>
    </aside>
  );
}
