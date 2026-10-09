import { redirect } from "next/navigation";

/** Journals are a tab of Memory now; old links keep their filters. */
export default async function JournalsPage(props: PageProps<"/journals">) {
  const sp = await props.searchParams;
  const qs = new URLSearchParams({ tab: "journal" });
  for (const key of ["q", "agent", "from", "to", "page"]) {
    const value = sp[key];
    if (typeof value === "string" && value) qs.set(key, value);
  }
  redirect(`/memory?${qs}`);
}
