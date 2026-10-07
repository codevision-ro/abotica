"use client";

import { useState } from "react";

/**
 * Unsaved changes of a form: compares its values, as JSON, with the last saved ones. Sort lists and keys
 * before passing them in, so undoing a change makes the form clean again. `markSaved` takes the values
 * that were saved; by default the ones of the render it comes from.
 */
export function useDirtySnapshot(values: unknown) {
  const json = JSON.stringify(values);
  const [saved, setSaved] = useState(json);
  const markSaved = (next: unknown = values) => setSaved(JSON.stringify(next));
  return { dirty: json !== saved, markSaved };
}
