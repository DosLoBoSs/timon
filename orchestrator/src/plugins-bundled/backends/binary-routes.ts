/**
 * `/api/host/binaries` — the backend CLIs this machine runs, and the paths
 * pinned for them from Settings › AI models (TODO #413).
 *
 * A person signed in to the app with full access to the Providers screen
 * (the superadmin, or `providers:manage`, `users/provider-access.ts`), on
 * reads too: the paths name the home folder and the account. Neither the
 * daemon token nor a mission token may choose the program every mission of a
 * backend will execute — the CLI operator still has `timon.config.json` for
 * that. Contract: `docs/HOST-BINARIES.md`.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireProviderAccess } from '../../users/provider-access.js';
import {
  BinaryPinError, binaryPinStatuses, pinBinary, recheckBinaries, unpinBinary,
} from '../../backends/binary-pins.js';

const pinBodySchema = z.object({ path: z.string().min(1).max(4096) }).strict();

/** A person signed in to the app with full access to the Providers screen. */
export function requireSessionProvidersManager(req: Request, res: Response): boolean {
  return requireProviderAccess(req, res, 'full', {
    session: true,
    sessionReason: 'only a person signed in to the app may manage the programs of the providers',
    sessionHint: 'do it from Settings › AI models › Providers in the app, or edit host.binaries in timon.config.json',
  }) !== null;
}

function nameOf(req: Request): string {
  const value = req.params.name;
  return typeof value === 'string' ? value : '';
}

function sendError(res: Response, err: unknown, context: string): void {
  if (err instanceof BinaryPinError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.warn(`[backends] ${context}: ${(err as Error).message}`);
  res.status(500).json({ error: 'pin_failed', message: 'The configuration could not be written.' });
}

export function registerBinaryRoutes(router: Router): void {
  router.get('/api/host/binaries', (req, res) => {
    if (!requireSessionProvidersManager(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ binaries: binaryPinStatuses() });
  });

  // Before `/:name`: `recheck` is not a binary.
  router.post('/api/host/binaries/recheck', async (req, res) => {
    if (!requireSessionProvidersManager(req, res)) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await recheckBinaries());
    } catch (err) {
      sendError(res, err, 'binary recheck');
    }
  });

  router.put('/api/host/binaries/:name', async (req, res) => {
    if (!requireSessionProvidersManager(req, res)) return;
    const body = pinBodySchema.safeParse(req.body ?? {});
    // zod's issues would quote the input: a fixed message instead.
    if (!body.success) {
      res.status(400).json({ error: 'invalid_body', message: 'expected `{ path: string }`' });
      return;
    }
    try {
      res.json({ binaries: await pinBinary(nameOf(req), body.data.path) });
    } catch (err) {
      sendError(res, err, 'binary pin');
    }
  });

  router.delete('/api/host/binaries/:name', async (req, res) => {
    if (!requireSessionProvidersManager(req, res)) return;
    try {
      res.json({ binaries: await unpinBinary(nameOf(req)) });
    } catch (err) {
      sendError(res, err, 'binary unpin');
    }
  });
}
