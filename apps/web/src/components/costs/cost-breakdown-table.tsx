import type { LucideIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SectionCard, SectionEmpty } from "@/components/app/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";

export type BreakdownRow = {
  key: string;
  label: React.ReactNode;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
};

const HEAD = "h-9 text-xs font-medium text-muted-foreground";

export async function CostBreakdownTable({
  icon,
  title,
  firstColumn,
  rows,
  total,
}: {
  icon: LucideIcon;
  title: string;
  firstColumn: string;
  rows: BreakdownRow[];
  total: number;
}) {
  const [t, fmt] = await Promise.all([getTranslations("costs.breakdown"), getFormat()]);
  return (
    <SectionCard icon={icon} title={title} flush>
      {rows.length === 0 ? (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      ) : (
        <Table>
          <TableHeader className="bg-muted/30 [&_tr]:border-border/60">
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, "pl-4 sm:pl-5")}>{firstColumn}</TableHead>
              <TableHead className={cn(HEAD, "text-right")}>{t("runs")}</TableHead>
              <TableHead className={cn(HEAD, "hidden text-right sm:table-cell")}>{t("tokens")}</TableHead>
              <TableHead className={cn(HEAD, "pr-4 text-right sm:pr-5")}>{t("cost")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const share = total > 0 ? r.cost / total : 0;
              return (
                <TableRow key={r.key} className="border-border/60 hover:bg-muted/30">
                  <TableCell className="w-full max-w-0 py-2.5 pl-4 whitespace-normal sm:pl-5">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex min-w-0">{r.label}</div>
                      {total > 0 && (
                        <div aria-hidden className="h-1 w-full max-w-48 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary/70" style={{ width: `${share * 100}%` }} />
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="tabular w-16 text-right text-muted-foreground">{r.runs}</TableCell>
                  <TableCell className="tabular hidden w-36 text-right text-muted-foreground sm:table-cell">
                    {fmt.tokens(r.inputTokens)} / {fmt.tokens(r.outputTokens)}
                  </TableCell>
                  <TableCell className="w-24 pr-4 text-right sm:pr-5">
                    <div className="tabular font-medium">{fmt.usd(r.cost)}</div>
                    {total > 0 && <div className="tabular text-xs text-muted-foreground">{Math.round(share * 100)}%</div>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
