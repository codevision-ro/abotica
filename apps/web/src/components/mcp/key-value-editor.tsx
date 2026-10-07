"use client";

import { KeyRound, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { KeepStored, StoredValue } from "@abotica/core/mcp-stored-values";
import { SecretInsertMenu } from "./secret-insert-menu";

/**
 * One entry. `keep` marks a saved value the server did not send (it does not reference the vault):
 * the row keeps it, under the key it was saved with, until a new value is typed.
 */
export type KeyValueRow = { key: string; value: string; keep?: string };

export function toRows(record: Record<string, StoredValue>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => (value === null ? { key, value: "", keep: key } : { key, value }));
}

export function toRecord(rows: KeyValueRow[]): Record<string, string | KeepStored> {
  const out: Record<string, string | KeepStored> = {};
  for (const r of rows) {
    if (r.key.trim()) out[r.key.trim()] = r.keep && !r.value ? { keep: r.keep } : r.value;
  }
  return out;
}

/**
 * Editable key/value list; each value can get a {{secret:NAME}} reference inserted from the vault.
 * Saved values that do not use the vault stay hidden: their field is empty and typing replaces them.
 */
export function KeyValueEditor({
  rows,
  onChange,
  secretNames,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  secretNames: string[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const t = useTranslations("mcp.keyValue");
  const update = (i: number, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-3 sm:gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <Input
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            aria-label={t("key")}
            title={row.key || undefined}
            className="w-full font-mono text-xs sm:w-2/5"
          />
          <Input
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={row.keep ? t("hiddenValue") : valuePlaceholder}
            aria-label={t("value")}
            title={row.keep && !row.value ? t("hiddenValueHint") : undefined}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <SecretInsertMenu
            secretNames={secretNames}
            onPick={(name) => update(i, { value: `${row.value}{{secret:${name}}}` })}
          >
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("insertSecret")} title={t("insertSecret")}>
              <KeyRound />
            </Button>
          </SecretInsertMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("removeRow")}
            title={t("removeRow")}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}
