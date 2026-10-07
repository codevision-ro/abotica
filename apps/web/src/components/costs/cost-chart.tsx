"use client";

import { parseISO } from "date-fns";
import { useTranslations } from "next-intl";
import { Bar, BarChart, BarStack, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";

type CostSeries = { key: string; label: string };
type CostPoint = { day: string } & Record<string, number | string>;

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--chart-1)",
  openai: "var(--chart-2)",
  deepseek: "var(--chart-3)",
  moonshot: "var(--chart-4)",
  ollama: "var(--chart-5)",
};
const FALLBACK_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

/** Daily cost as bars stacked by provider. */
export function CostChart({
  points,
  series,
  className,
}: {
  points: CostPoint[];
  series: CostSeries[];
  className?: string;
}) {
  const fmt = useFormat();
  const tc = useTranslations("common.states");
  const dayLabel = (day: string) => fmt.date(parseISO(day), "d MMM");
  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [
      s.key,
      // "unknown" is the series of runs without a provider (see getDailyCostByProvider).
      {
        label: s.key === "unknown" ? tc("unknown") : s.label,
        color: PROVIDER_COLORS[s.key] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length],
      },
    ]),
  );
  const value = (p: CostPoint, key: string) => Number(p[key] ?? 0);

  return (
    <ChartContainer config={config} className={cn("aspect-auto h-64 w-full", className)}>
      <BarChart data={points} margin={{ left: 0, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayLabel} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickCount={4}
          tickFormatter={(v: number) => `$${Number(v.toPrecision(3))}`}
        />
        <ChartTooltip
          cursor={{ radius: 4 }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const point = payload?.[0]?.payload as CostPoint | undefined;
                if (!point) return "";
                const total = series.reduce((sum, s) => sum + value(point, s.key), 0);
                return (
                  <div className="flex items-baseline justify-between gap-4">
                    <span>{fmt.date(parseISO(point.day), "EEEE, d MMMM")}</span>
                    {series.length > 1 && <span className="font-mono tabular-nums">{fmt.usd(total)}</span>}
                  </div>
                );
              }}
              formatter={(v, name, item) => (
                <div className="flex w-full items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
                  <span className="text-muted-foreground">{config[String(name)]?.label ?? name}</span>
                  <span className="ml-auto font-mono font-medium text-foreground tabular-nums">{fmt.usd(Number(v))}</span>
                </div>
              )}
            />
          }
        />
        {series.length > 1 && <ChartLegend content={<ChartLegendContent className="pt-4" />} />}
        {/* The stack rounds only its outer top corners, whichever provider ends up on top. */}
        <BarStack stackId="cost" radius={[4, 4, 0, 0]}>
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={`var(--color-${s.key})`}
              stroke="var(--card)"
              strokeWidth={series.length > 1 ? 1 : 0}
              maxBarSize={24}
            />
          ))}
        </BarStack>
      </BarChart>
    </ChartContainer>
  );
}
