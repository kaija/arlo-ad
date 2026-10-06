// Interactive control ids (design.md「ChatAdapter」): cs:{verb}:{changesetId},
// shadow:{up|down}:{changesetId}, neg:toggle:{changesetId}:{opIndex}.

export const CHANGESET_VERBS = ['approve', 'reject', 'undo', 'keep', 'confirm'] as const;
export type ChangeSetVerb = (typeof CHANGESET_VERBS)[number];

export type ChatAction =
  | { kind: 'changeset'; verb: ChangeSetVerb; changesetId: string }
  | { kind: 'shadow'; verdict: 'up' | 'down'; changesetId: string }
  | { kind: 'neg_toggle'; changesetId: string; opIndex: number };

const ID = /^[0-9a-f-]{1,64}$/i;

export function encodeAction(action: ChatAction): string {
  if (!ID.test(action.changesetId)) throw new Error('invalid changeset id');
  switch (action.kind) {
    case 'changeset':
      return `cs:${action.verb}:${action.changesetId}`;
    case 'shadow':
      return `shadow:${action.verdict}:${action.changesetId}`;
    case 'neg_toggle':
      return `neg:toggle:${action.changesetId}:${action.opIndex}`;
  }
}

/** Parses an action id; anything unexpected (including tampered ids) yields null. */
export function decodeAction(actionId: string): ChatAction | null {
  const parts = actionId.split(':');
  const [prefix, verb, id, index] = parts;
  if (!id || !ID.test(id)) return null;
  if (prefix === 'cs' && parts.length === 3 && (CHANGESET_VERBS as readonly string[]).includes(verb!)) {
    return { kind: 'changeset', verb: verb as ChangeSetVerb, changesetId: id };
  }
  if (prefix === 'shadow' && parts.length === 3 && (verb === 'up' || verb === 'down')) {
    return { kind: 'shadow', verdict: verb, changesetId: id };
  }
  if (prefix === 'neg' && verb === 'toggle' && parts.length === 4 && /^\d{1,4}$/.test(index!)) {
    return { kind: 'neg_toggle', changesetId: id, opIndex: Number(index) };
  }
  return null;
}
