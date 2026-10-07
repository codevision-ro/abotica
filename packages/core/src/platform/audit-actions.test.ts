import { locales, messages } from "@abotica/i18n";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, auditActionKey } from "./audit-actions";

describe("audit action labels", () => {
  const expected = AUDIT_ACTIONS.map(auditActionKey).sort();

  it.each(locales)("%s labels exactly the audit actions", (locale) => {
    expect(Object.keys(messages[locale].settings.audit.actions).sort()).toEqual(expected);
  });
});
