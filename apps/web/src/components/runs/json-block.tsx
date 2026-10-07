import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

function toJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Monospace, scrollable block for tool inputs and outputs. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  const t = useTranslations("runs.json");
  const text = toJson(value);
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/35 px-3 py-2.5 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-foreground/90 dark:bg-muted/25",
        className,
      )}
    >
      {text || <span className="text-muted-foreground">{t("empty")}</span>}
    </pre>
  );
}
