"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { chipVariants } from "@/components/app/selectable-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The value to store, or the message to show next to the input. */
export type TokenParse = { value: string } | { error: string };

/**
 * A list of short values (domains, package names) shown as removable pills, with an input that adds
 * one or more at a time. Pasting "a, b c" adds all three; the ones that fail stay in the input with
 * the reason below it. A value left typed in the input is added when the input loses focus, so it is
 * not lost when the user goes straight to Save.
 */
export function TokenListEditor({
  label,
  values,
  onChange,
  parse,
  max,
  tooMany,
  placeholder,
  addLabel,
  removeLabel,
  className,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  parse: (raw: string) => TokenParse;
  max: number;
  /** Message when adding would go over `max`. */
  tooMany: string;
  placeholder: string;
  addLabel: string;
  removeLabel: (value: string) => string;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const raw = draft.split(/[\s,]+/).filter(Boolean);
    if (!raw.length) return setError(null);
    const next = [...values];
    const rejected: string[] = [];
    let message: string | null = null;
    for (const token of raw) {
      const parsed = parse(token);
      if ("error" in parsed) {
        rejected.push(token);
        message ??= parsed.error;
      } else if (!next.includes(parsed.value)) {
        if (next.length >= max) {
          rejected.push(token);
          message ??= tooMany;
        } else next.push(parsed.value);
      }
    }
    if (next.length !== values.length) onChange(next);
    setDraft(rejected.join(" "));
    setError(message);
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // Enter adds the value instead of submitting the surrounding form.
            e.preventDefault();
            commit();
          }}
          onBlur={commit}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-sm"
        />
        <Button type="button" variant="outline" onClick={commit} disabled={!draft.trim()}>
          <PlusIcon />
          {addLabel}
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {values.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li key={value} className={chipVariants({ selected: true, className: "h-7 gap-1 pr-1 pl-2.5" })}>
              <span className="min-w-0 truncate font-mono text-xs" title={value}>
                {value}
              </span>
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== value))}
                aria-label={removeLabel(value)}
                className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <XIcon className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
