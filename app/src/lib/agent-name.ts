/**
 * A display name typed by a human → the agent name Timon will actually use.
 *
 * The daemon is authoritative (`orchestrator/src/onboarding-main-agent.ts`
 * applies the same conversion, and it is the one that writes the directory).
 * The onboarding screen calls it to SHOW the result while the user types
 * instead of surprising them after the fact: an agent name is a filesystem
 * identity, so "Nova, mon assistante" cannot be one verbatim. The conversion
 * itself lives in `agent-name-rule.ts`, the verbatim copy of the daemon's rule.
 */
export { toAgentName } from './agent-name-rule';
