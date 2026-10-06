import { describe, expect, it } from 'vitest';
import { decodeAction, encodeAction, type ChatAction } from './actions';

const id = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';

describe('chat action ids', () => {
  it.each<[ChatAction, string]>([
    [{ kind: 'changeset', verb: 'approve', changesetId: id }, `cs:approve:${id}`],
    [{ kind: 'changeset', verb: 'reject', changesetId: id }, `cs:reject:${id}`],
    [{ kind: 'changeset', verb: 'undo', changesetId: id }, `cs:undo:${id}`],
    [{ kind: 'changeset', verb: 'keep', changesetId: id }, `cs:keep:${id}`],
    [{ kind: 'changeset', verb: 'confirm', changesetId: id }, `cs:confirm:${id}`],
    [{ kind: 'shadow', verdict: 'up', changesetId: id }, `shadow:up:${id}`],
    [{ kind: 'shadow', verdict: 'down', changesetId: id }, `shadow:down:${id}`],
    [{ kind: 'neg_toggle', changesetId: id, opIndex: 12 }, `neg:toggle:${id}:12`],
  ])('round-trips %j', (action, encoded) => {
    expect(encodeAction(action)).toBe(encoded);
    expect(decodeAction(encoded)).toEqual(action);
  });

  it.each([
    'cs:delete:' + id,
    'cs:approve',
    'cs:approve:' + id + ':extra',
    'shadow:sideways:' + id,
    'neg:toggle:' + id,
    'neg:toggle:' + id + ':-1',
    'neg:remove:' + id + ':1',
    'cs:approve:not an id',
    '',
  ])('rejects %s', (encoded) => {
    expect(decodeAction(encoded)).toBeNull();
  });

  it('refuses to encode a malformed id', () => {
    expect(() => encodeAction({ kind: 'changeset', verb: 'approve', changesetId: 'x:y' })).toThrow();
  });
});
