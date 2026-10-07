"use client";

import { useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Vault secret picker around any trigger button; `onPick` gets the secret name. */
export function SecretInsertMenu({
  secretNames,
  onPick,
  children,
}: {
  secretNames: string[];
  onPick: (name: string) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("mcp.keyValue");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 max-w-[min(22rem,calc(100vw-2rem))] overflow-y-auto">
        <DropdownMenuLabel>{t("vaultSecrets")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {secretNames.length === 0 ? (
          <DropdownMenuItem disabled>{t("noSecrets")}</DropdownMenuItem>
        ) : (
          secretNames.map((name) => (
            <DropdownMenuItem key={name} className="font-mono text-xs" onSelect={() => onPick(name)}>
              <span className="truncate" title={name}>
                {name}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
