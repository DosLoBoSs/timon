/**
 * `:name` in a route of a router whose `:name` is always an agent, stored in
 * NFC before any handler reads it: a decomposed accent sent by a Mac names the
 * same agent as the composed one, not a second folder on Linux. A router
 * holds its params for itself, so each router that takes an agent name calls
 * this once.
 */
import type { IRouter } from 'express';
import { normalizeAgentName } from './agent-name.js';

export function normalizeAgentNameParam(router: Pick<IRouter, 'param'>): void {
  router.param('name', (req, _res, next, value: unknown) => {
    if (typeof value === 'string') req.params.name = normalizeAgentName(value);
    next();
  });
}
