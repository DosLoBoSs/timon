/**
 * `/api/backends/host-sign-in/:backend` — the host's own sign-in of a backend,
 * kept by Timon or not (TODO #426): signed in from the browser into Timon's
 * folder, a long-lived token minted in the app, or back to the CLI's own
 * session.
 *
 * The host's sign-in is the instance's, not a person's: every verb wants the
 * `full` level of the Providers screen (`providers:manage`, the superadmin).
 * A mission token never reaches it. A flow (`/login`, `/token`) starts from a
 * browser session only, and is bound to it like an account's
 * (`account-routes.ts`): another session, even the same user's, gets 404. The
 * pasted code travels in the body, never in the URL, and is never echoed back
 * nor logged; nothing the CLI prints comes back but the page's address.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { forbidden, viewerFromRequest } from '../../users/identity.js';
import { requireProviderAccess } from '../../users/provider-access.js';
import { SESSION_COOKIE, hashSessionToken, readCookie } from '../../users/session.js';
import { auditRequest } from '../../users/audit-actor.js';
import { apiError } from '../../api-error.js';
import {
  LoginFlowError, cancelHostLogin, cancelHostToken, forgetHostLogin, getHostLogin, getHostToken, hostSignInSupport,
  startHostLogin, startHostToken, submitHostLoginCode, submitHostTokenCode, type LoginInitiator, type LoginView,
} from '../../backends/account-login.js';
import { hostSignInView } from '../../backends/host-sign-in-view.js';

const Backend = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const EmptyBody = z.object({}).strict();
/** One line: a line break would feed the CLI's next prompt. */
const CodeBody = z.object({
  code: z.string().min(1).max(4096).refine((value) => !/[\r\n]/.test(value), { message: 'one line only' }),
}).strict();

/** The backend of the request when it may keep the host's sign-in, or null once answered. */
function backendOf(req: Request, res: Response): string | null {
  const parsed = Backend.safeParse(req.params['backend']);
  if (!parsed.success || !hostSignInSupport(parsed.data)) {
    res.status(404).json(apiError('backend_unknown', 'this backend cannot keep the host sign-in'));
    return null;
  }
  return parsed.data;
}

/** The operator, at the `full` level: the host's sign-in is the instance's. */
function operator(req: Request, res: Response): boolean {
  return requireProviderAccess(req, res, 'full') !== null;
}

/**
 * The session a flow is bound to. Only a browser session starts one: the
 * daemon token and mission tokens are no one's browser.
 */
function flowInitiator(req: Request, res: Response): LoginInitiator | null {
  if (!operator(req, res)) return null;
  const viewer = viewerFromRequest(req);
  const raw = req.auth!.kind === 'session' ? readCookie(req.headers.cookie, SESSION_COOKIE) : undefined;
  if (!viewer || !raw) {
    forbidden(req, res, { kind: 'scope', reason: 'the host sign-in is done from a browser session', hint: 'Sign in from the UI (Settings → AI models → Providers).' });
    return null;
  }
  return { userId: viewer.id, binding: hashSessionToken(raw) };
}

function invalid(res: Response, error: z.ZodError): void {
  const fields = error.issues.map((issue) => issue.path.join('.') || 'body');
  res.status(400).json({ ...apiError('invalid_fields', 'invalid body', { fields: fields.join(', ') }), fields });
}

function refused(res: Response, error: unknown): void {
  if (!(error instanceof LoginFlowError)) throw error;
  const status = error.code === 'bad_code' || error.code === 'unsupported' ? 400 : 409;
  res.status(status).json(apiError('signin_refused', error.message, { detail: error.message }));
}

type FlowApi = {
  start(backend: string, who: LoginInitiator): LoginView;
  read(backend: string, who: LoginInitiator): LoginView | undefined;
  code(backend: string, who: LoginInitiator, code: string): LoginView | undefined;
  cancel(backend: string, who: LoginInitiator): LoginView | undefined;
};

const FLOWS: Readonly<Record<'login' | 'token', FlowApi>> = {
  login: { start: startHostLogin, read: getHostLogin, code: submitHostLoginCode, cancel: cancelHostLogin },
  token: { start: startHostToken, read: getHostToken, code: submitHostTokenCode, cancel: cancelHostToken },
};

export function registerHostSignInRoutes(router: Router): void {
  const base = '/api/backends/host-sign-in/:backend';

  router.get(base, (req, res) => {
    if (!operator(req, res)) return;
    const backend = backendOf(req, res);
    if (!backend) return;
    res.json({ hostSignIn: hostSignInView(backend) });
  });

  // Back to the CLI's own sign-in (the terminal's session).
  router.delete(base, async (req, res) => {
    if (!operator(req, res)) return;
    const backend = backendOf(req, res);
    if (!backend) return;
    if (await forgetHostLogin(backend)) auditRequest(req, 'backend_host.forget', backend);
    res.json({ hostSignIn: hostSignInView(backend) });
  });

  for (const [kind, flow] of Object.entries(FLOWS) as Array<[keyof typeof FLOWS, FlowApi]>) {
    router.post(`${base}/${kind}`, (req, res) => {
      const who = flowInitiator(req, res);
      if (!who) return;
      const backend = backendOf(req, res);
      if (!backend) return;
      const parsed = EmptyBody.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, parsed.error);
      try {
        res.status(202).json({ login: flow.start(backend, who) });
      } catch (error) {
        refused(res, error);
      }
    });

    router.get(`${base}/${kind}`, (req, res) => {
      const who = flowInitiator(req, res);
      if (!who) return;
      const backend = backendOf(req, res);
      if (!backend) return;
      const login = flow.read(backend, who);
      if (!login) return void res.status(404).json(apiError('signin_not_in_progress', 'no sign-in in progress'));
      res.json({ login });
    });

    router.post(`${base}/${kind}/code`, (req, res) => {
      const who = flowInitiator(req, res);
      if (!who) return;
      const backend = backendOf(req, res);
      if (!backend) return;
      const parsed = CodeBody.safeParse(req.body);
      if (!parsed.success) return invalid(res, parsed.error);
      try {
        const login = flow.code(backend, who, parsed.data.code);
        if (!login) return void res.status(404).json(apiError('signin_not_in_progress', 'no sign-in in progress'));
        res.json({ login });
      } catch (error) {
        refused(res, error);
      }
    });

    router.delete(`${base}/${kind}`, (req, res) => {
      const who = flowInitiator(req, res);
      if (!who) return;
      const backend = backendOf(req, res);
      if (!backend) return;
      const login = flow.cancel(backend, who);
      if (!login) return void res.status(404).json(apiError('signin_not_in_progress', 'no sign-in in progress'));
      res.json({ login });
    });
  }
}
