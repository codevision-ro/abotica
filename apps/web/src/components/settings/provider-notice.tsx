import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/** A quiet note inside a provider card: what an action will change, or why a connection stopped. */
export function ProviderNotice({ tone = "info", children }: { tone?: "info" | "warning"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "info"
          ? "bg-muted/60 text-muted-foreground"
          : "bg-warning/15 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning",
      )}
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}
