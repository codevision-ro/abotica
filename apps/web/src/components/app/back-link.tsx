import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/** The link back to a page's list, above its header. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="sm" className="-mb-2 self-start" asChild>
      <Link href={href}>
        <ArrowLeftIcon /> {children}
      </Link>
    </Button>
  );
}
