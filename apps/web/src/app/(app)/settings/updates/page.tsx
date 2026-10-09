import { permanentRedirect } from "next/navigation";

/** Updates are part of Settings > System. */
export default function UpdatesSettingsRedirect() {
  permanentRedirect("/settings/system");
}
