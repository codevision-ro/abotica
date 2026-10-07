import { useTranslations } from "next-intl";

/**
 * Built-in tools get their translated label (`tools.<name>.label`); MCP tools are named "<server>__<tool>".
 * Unknown names are shown as-is.
 */
export function useToolLabel() {
  const t = useTranslations();
  return (name: string): { label: string; server: string | null } => {
    const key = `tools.${name}.label` as Parameters<typeof t>[0];
    if (t.has(key)) return { label: t(key), server: null };
    const sep = name.indexOf("__");
    if (sep > 0) return { label: name.slice(sep + 2), server: name.slice(0, sep) };
    return { label: name, server: null };
  };
}
