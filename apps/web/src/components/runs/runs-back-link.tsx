"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

/** sessionStorage key with the runs list URL (filters and page) last seen in this tab. */
export const RUNS_LIST_KEY = "abotica:runs-list";

const read = () => {
  try {
    return sessionStorage.getItem(RUNS_LIST_KEY) ?? "/runs";
  } catch {
    return "/runs";
  }
};

/** Back to the runs list, with the filters and page the user left it on. */
export function RunsBackLink() {
  const t = useTranslations("runs.detail");
  const href = useSyncExternalStore(
    () => () => {},
    read,
    () => "/runs",
  );
  return (
    <Button variant="ghost" size="sm" className="-mb-2 self-start" asChild>
      <Link href={href}>
        <ArrowLeft /> {t("back")}
      </Link>
    </Button>
  );
}
