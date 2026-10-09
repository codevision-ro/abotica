import { useTranslations } from "next-intl";
import { type Tone, ToneBadge } from "@/components/app/status-badge";

const APPROVAL_TONE: Record<string, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "destructive",
  expired: "muted",
};

export function ApprovalStatusBadge({ status }: { status: string }) {
  const t = useTranslations("approvals.status");
  const key = status as Parameters<typeof t>[0];
  return <ToneBadge tone={APPROVAL_TONE[status] ?? "muted"}>{t.has(key) ? t(key) : status}</ToneBadge>;
}
