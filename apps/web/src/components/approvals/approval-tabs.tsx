"use client";

import { Tabs } from "@/components/ui/tabs";

/** Tabs whose choice is written to ?tab=, so reload and back keep the open tab. */
export function ApprovalTabs({ defaultValue, children }: { defaultValue: string; children: React.ReactNode }) {
  return (
    <Tabs
      defaultValue={defaultValue}
      onValueChange={(tab) => {
        const url = new URL(window.location.href);
        if (tab === "pending") url.searchParams.delete("tab");
        else url.searchParams.set("tab", tab);
        window.history.replaceState(null, "", url);
      }}
    >
      {children}
    </Tabs>
  );
}
