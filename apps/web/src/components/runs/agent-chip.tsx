import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { cn } from "@/lib/utils";

export function AgentChip({
  name,
  avatar,
  className,
}: {
  name: string | null | undefined;
  avatar: AgentAvatarValue | null | undefined;
  className?: string;
}) {
  const t = useTranslations("runs.agentChip");
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <AgentAvatar avatar={avatar} size="md" />
      <span className="truncate font-medium">{name ?? t("deleted")}</span>
    </span>
  );
}
