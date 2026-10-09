import { BUSINESS_TEMPLATES } from "./business";
import { ENGINEERING_TEMPLATES } from "./engineering";
import { MANAGEMENT_TEMPLATES } from "./management";
import { MARKETING_TEMPLATES } from "./marketing";

/** The agent templates the seed installs, one file per domain. */
export const AGENT_TEMPLATES = [
  ...MANAGEMENT_TEMPLATES,
  ...ENGINEERING_TEMPLATES,
  ...MARKETING_TEMPLATES,
  ...BUSINESS_TEMPLATES,
];

/**
 * Templates that later releases replaced, removed from installs where the user never edited them:
 * template-web-developer became template-software-engineer.
 */
export const RETIRED_TEMPLATES = ["template-web-developer"];
