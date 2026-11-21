/**
 * The host's own sign-in of a backend, kept by Timon (TODO #426).
 *
 * Without it, the profile without an account (`claude`) runs on whatever the
 * CLI finds in its default folder (`~/.claude`, the macOS login keychain): the
 * user signs in in a terminal. A person who has no such session signs in from
 * the browser instead, with the login driver of the accounts
 * (`account-login.ts`), and the sign-in lands in a private folder of Timon,
 * never in `~/.claude`.
 *
 * That folder sits among the account folders (`backend-accounts/<id>`) under
 * a fixed id per backend, so everything an account's sign-in already gets
 * applies to it unchanged: the fence opens it to the mission (and to no other
 * account's), the macOS keychain entry named after it moves into it before a
 * fenced launch, and a sign-in flow holds it while its CLI may write it. The
 * id is not hexadecimal, so it never meets an account's (`createBackendAccount`
 * mints hex). No row of `backend_accounts`: it is not an account, it is in no
 * rotation and no selector, and nobody but the operator manages it.
 *
 * A row here holds no secret: who it is signed in as, for the screen.
 */
import { rmSync } from 'node:fs';
import { db } from '../db.js';
import { accountConfigDir, backendAccountsChanged } from './accounts.js';
import { ACCOUNT_ID_RE, splitBackendInstance } from './instance-id.js';

db.exec(`
CREATE TABLE IF NOT EXISTS host_sign_ins (
  backend TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL,
  identity_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

export type HostSignIn = {
  backend: string;
  /** Who it is signed in as (an e-mail): for the operator's screen only. */
  identityLabel: string;
  identityKey: string;
  createdAt: number;
  updatedAt: number;
};

type Row = { backend: string; identity_key: string; identity_label: string; created_at: number; updated_at: number };

/** The id the host's kept sign-in of `backend` goes by among the account folders. */
export function hostSignInId(backend: string): string {
  const id = `host${backend}`;
  if (!ACCOUNT_ID_RE.test(id)) throw new Error(`backend ${backend} cannot keep a host sign-in`);
  return id;
}

/** Where the CLI of the host's kept sign-in keeps its configuration and its sign-in. */
export function hostSignInDir(backend: string): string {
  return accountConfigDir(hostSignInId(backend));
}

export function getHostSignIn(backend: string): HostSignIn | undefined {
  const row = db.prepare(`SELECT * FROM host_sign_ins WHERE backend = ?`).get(backend) as Row | undefined;
  return row ? {
    backend: row.backend, identityKey: row.identity_key, identityLabel: row.identity_label,
    createdAt: row.created_at, updatedAt: row.updated_at,
  } : undefined;
}

/** The host's sign-in of `backend` is now the one kept by Timon, as `identity`. */
export function recordHostSignIn(backend: string, identity: { key: string; label: string }): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO host_sign_ins (backend, identity_key, identity_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(backend) DO UPDATE SET identity_key = excluded.identity_key, identity_label = excluded.identity_label, updated_at = excluded.updated_at
  `).run(backend, identity.key, identity.label, now, now);
  backendAccountsChanged();
}

/**
 * Back to the CLI's own sign-in: the row and the folder go, the credential
 * with it. Signing a CLI out of the macOS keychain is the caller's, before.
 */
export function forgetHostSignIn(backend: string): boolean {
  const removed = db.prepare(`DELETE FROM host_sign_ins WHERE backend = ?`).run(backend).changes > 0;
  rmSync(hostSignInDir(backend), { recursive: true, force: true });
  if (removed) backendAccountsChanged();
  return removed;
}

/**
 * The account folder a launch of `backend` signs in from, as the fence and the
 * keychain move name it: the account of an instance, else the host's kept
 * sign-in of a base profile, else none (the CLI's own folder).
 */
export function credentialAccountOf(backend: string): string | null {
  const instance = splitBackendInstance(backend);
  if (instance.accountId) return instance.accountId;
  return getHostSignIn(instance.backend) ? hostSignInId(instance.backend) : null;
}

/** Tests only. */
export function resetHostSignIns(): void {
  db.exec(`DELETE FROM host_sign_ins`);
}
