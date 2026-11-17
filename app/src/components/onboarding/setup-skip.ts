/**
 * Answers step 3 with "skip". Only a daemon that says the step is complete
 * lets the wizard leave: navigating on a refusal sent the person to `/`, and the
 * gate straight back to `/setup/agent` — the trap again, one reload later.
 */
export async function requestSkip(): Promise<boolean> {
  try {
    const res = await fetch('/api/ui/setup/main-agent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skip: true }),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { status?: unknown } | null;
    return body?.status === 'complete';
  } catch {
    return false;
  }
}
