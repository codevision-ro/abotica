"use client";

import { useState } from "react";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The text of a value: empty for null and for NaN (nothing typed, or not a number). */
const shown = (value: number | null) => (value === null || Number.isNaN(value) ? "" : String(value));

/** The value of a text: null (nullable) or NaN while empty, NaN while it is not a number. */
function parse(text: string, nullable: boolean | undefined): number | null {
  const raw = text.trim().replace(",", ".");
  if (raw === "") return nullable ? null : Number.NaN;
  return Number(raw);
}

/**
 * A numeric setting as one responsive row: label and hint on the left, the input (with an optional unit)
 * on the right, the problem under it. The text is kept while typing ("1." or empty), and the value is
 * NaN while it is not a number, so the shared schema reports it. A `nullable` field is null while empty
 * ("no limit", shown by its placeholder).
 */
export function SettingsNumberField({
  id,
  label,
  hint,
  value,
  onChange,
  nullable,
  placeholder,
  error,
  min,
  max,
  step,
  unit,
  decimal = false,
  className,
}: (
  | { nullable?: false; value: number; onChange: (value: number) => void }
  | { nullable: true; value: number | null; onChange: (value: number | null) => void }
) & {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  placeholder?: string;
  error?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number ("MB", "min", "%"). */
  unit?: string;
  decimal?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(shown(value));
  // A value changed from outside (a reset, a save that normalized it) replaces what was typed; adjusted
  // while rendering, so the input never shows the old text for a frame.
  const [synced, setSynced] = useState(value);
  if (!Object.is(synced, value)) {
    setSynced(value);
    if (!Object.is(parse(text, nullable), value)) setText(shown(value));
  }

  return (
    <Field orientation="responsive" data-invalid={Boolean(error)} className={className}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint && <FieldDescription>{hint}</FieldDescription>}
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <div className="relative sm:w-32">
        <Input
          id={id}
          type="text"
          inputMode={decimal ? "decimal" : "numeric"}
          value={text}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          onChange={(e) => {
            const next = parse(e.target.value, nullable);
            setText(e.target.value);
            if (nullable) onChange(next);
            else onChange(next ?? Number.NaN);
          }}
          aria-invalid={Boolean(error)}
          className={cn("tabular", unit && "pr-12")}
        />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
    </Field>
  );
}
