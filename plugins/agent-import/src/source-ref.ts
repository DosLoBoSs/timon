/**
 * The `sourceRef` of an agent exported by a Timon: the key a re-import finds
 * its previous copy by.
 *
 * It is `timon:<instance>:id:<stable id>`: the id the source daemon keeps for
 * the agent across a rename, so a renamed agent updates its copy on the other
 * side instead of coming back as a second agent. An archive made before that
 * id existed (or by a daemon that gives none) named the agent
 * `timon:<instance>:<lower-case name>`; an agent name never holds a `:`, so the
 * two never meet. A re-import accepts both: the old form is an alias of the new.
 */

/** The application an export says it comes from: the key of a re-import on the other side. */
export const EXPORT_SOURCE_APP = 'timon';

const SOURCE_REF_MAX = 300;
const STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STABLE_REF_RE = /^timon:([a-f0-9]{16}):id:([0-9a-f-]{36})$/;

/** The form of before: the agent by name. */
export function legacySourceRef(instance: string, name: string): string {
  return `timon:${instance}:${name.toLowerCase()}`.slice(0, SOURCE_REF_MAX);
}

/** The `sourceRef` of an exported agent: its stable id, else its name. */
export function exportSourceRef(instance: string, agent: { id?: unknown; name: string }): string {
  if (typeof agent.id === 'string' && STABLE_ID_RE.test(agent.id)) return `timon:${instance}:id:${agent.id}`;
  return legacySourceRef(instance, agent.name);
}

/**
 * The other refs the same source agent may already be known by here: the name
 * form of an older archive of it, under the name it has in this archive.
 */
export function sourceRefAliases(sourceApp: string, agent: { sourceRef: string; displayName: string }): string[] {
  if (sourceApp !== EXPORT_SOURCE_APP) return [];
  const match = STABLE_REF_RE.exec(agent.sourceRef);
  if (!match || !STABLE_ID_RE.test(match[2]!)) return [];
  return [legacySourceRef(match[1]!, agent.displayName)];
}
