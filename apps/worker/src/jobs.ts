// Job handlers registered with pg-boss. Each handler is defined from a spec in the
// @arlo/queue catalog so producers and the worker share one payload schema.
import type { JobDefinition } from '@arlo/queue';

export function jobDefinitions(): JobDefinition[] {
  return [];
}
