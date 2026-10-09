import { useTranslations } from "next-intl";

/** Longest value shown in full; the rest is in its tooltip. */
const VALUE_MAX = 120;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Change = { from: unknown; to: unknown } | { fromLength: number; toLength: number };

/**
 * The fields of a `settings.updated` entry, each with its old and new value. Entries name each changed
 * field by its dotted path in the domain (`daily.hour`); older ones, from before the settings had domains,
 * have flat keys and sometimes extra values (`reembedding: 120`), which show as they are.
 */
export function AuditSettingsChanges({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations("settings.audit.changes");
  const entries = Object.entries(data);
  if (!entries.length) return <span className="text-xs text-muted-foreground">-</span>;

  const show = (value: unknown): string => {
    if (value === null || value === undefined) return t("none");
    if (typeof value === "boolean") return value ? t("on") : t("off");
    if (typeof value === "string") return value === "" ? t("empty") : value;
    if (Array.isArray(value)) return value.length ? value.map(show).join(", ") : t("none");
    if (isRecord(value)) return JSON.stringify(value);
    return String(value);
  };

  const change = (value: unknown): Change | null => {
    if (!isRecord(value)) return null;
    if ("from" in value && "to" in value) return { from: value.from, to: value.to };
    if (typeof value.fromLength === "number" && typeof value.toLength === "number") {
      return { fromLength: value.fromLength, toLength: value.toLength };
    }
    return null;
  };

  return (
    <dl className="flex min-w-0 flex-col gap-1.5 text-xs">
      {entries.map(([field, value]) => {
        const c = change(value);
        return (
          <div key={field} className="min-w-0">
            <dt className="font-mono text-muted-foreground [overflow-wrap:anywhere]">{field}</dt>
            <dd className="[overflow-wrap:anywhere]">
              {!c ? (
                <Value text={show(value)} />
              ) : "fromLength" in c ? (
                t("length", { from: c.fromLength, to: c.toLength })
              ) : (
                <>
                  <Value
                    text={show(c.from)}
                    className="text-muted-foreground line-through decoration-muted-foreground/50"
                  />
                  <span aria-hidden className="mx-1.5 text-muted-foreground">
                    →
                  </span>
                  <span className="sr-only"> {t("to")} </span>
                  <Value text={show(c.to)} className="font-medium" />
                </>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Value({ text, className }: { text: string; className?: string }) {
  const long = text.length > VALUE_MAX;
  return (
    <span className={className} title={long ? text : undefined}>
      {long ? `${text.slice(0, VALUE_MAX)}...` : text}
    </span>
  );
}
