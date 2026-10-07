/** Pure rules for the files delegate_task hands to a task. */

type Incoming = { path: string; name: string; data: Uint8Array };
type Previous = { id: string; name: string; data: Uint8Array | null };

export type HandoverPlan<T extends Incoming> =
  | { error: string }
  | {
      /** Files to store for the task. */
      save: T[];
      /** Earlier handed-over files the new ones replace. */
      replace: string[];
      /** Earlier handed-over files sent again unchanged; nothing is stored for them. */
      keep: string[];
    };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

/**
 * What handing files to a task does, also when the task is delegated again. The task keeps one file
 * per name among the files delegating agents handed over (`previous`): the same name with the same
 * bytes is kept as is (a retry sends the same files again), the same name with other bytes replaces
 * the earlier file (the delegator sends a corrected version back). The user's attachments and the
 * files the task's own runs produced are not in `previous`, so they are never replaced. Two files
 * with the same name in one call are refused, since the task could keep only one of them.
 */
export function planHandover<T extends Incoming>(incoming: T[], previous: Previous[]): HandoverPlan<T> {
  const seen = new Map<string, string>();
  for (const file of incoming) {
    const other = seen.get(file.name);
    if (other !== undefined) {
      return { error: `${other} and ${file.path} are both named ${file.name}. Rename one before handing them over.` };
    }
    seen.set(file.name, file.path);
  }
  const plan = { save: [] as T[], replace: [] as string[], keep: [] as string[] };
  for (const file of incoming) {
    const earlier = previous.filter((p) => p.name === file.name);
    const same = earlier.find((p) => p.data && sameBytes(p.data, file.data));
    if (same) {
      plan.keep.push(same.id);
      plan.replace.push(...earlier.filter((p) => p !== same).map((p) => p.id));
    } else {
      plan.save.push(file);
      plan.replace.push(...earlier.map((p) => p.id));
    }
  }
  return plan;
}
