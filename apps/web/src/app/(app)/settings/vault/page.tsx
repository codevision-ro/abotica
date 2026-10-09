import { redirect } from "next/navigation";

/** The vault is Settings > Secrets now; old links and bookmarks land there. */
export default function VaultPage() {
  redirect("/settings/secrets");
}
