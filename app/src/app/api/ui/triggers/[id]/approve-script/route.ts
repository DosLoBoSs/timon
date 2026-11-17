import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The browser's session cookie is what the daemon checks: a re-approval is a person's, never a token's.
export async function POST(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  return proxyJson('POST', `/api/triggers/${encodeURIComponent(params.id)}/approve-script`, {});
}
