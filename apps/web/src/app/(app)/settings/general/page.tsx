import { permanentRedirect } from "next/navigation";

/** General moved to /settings itself. */
export default function GeneralSettingsRedirect() {
  permanentRedirect("/settings");
}
