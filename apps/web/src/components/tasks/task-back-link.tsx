"use client";

import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { opensElsewhere, tasksListHref } from "./task-meta";

/** Back to the board or list with the filters the user had, not a bare /tasks. */
export function TaskBackLink({ label }: { label: string }) {
  const router = useRouter();
  return (
    <Button variant="ghost" size="sm" className="-ml-2 self-start" asChild>
      <Link
        href="/tasks"
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          router.push(tasksListHref());
        }}
      >
        <ArrowLeftIcon />
        {label}
      </Link>
    </Button>
  );
}
