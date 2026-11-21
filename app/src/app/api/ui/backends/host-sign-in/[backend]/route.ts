import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The daemon checks the caller's level and the backend; the session cookie is forwarded.
export async function GET(_req: Request, { params }: { params: { backend: string } }): Promise<Response> {
  return proxyJson('GET', `/api/backends/host-sign-in/${encodeURIComponent(params.backend)}`);
}

export async function DELETE(_req: Request, { params }: { params: { backend: string } }): Promise<Response> {
  return proxyJson('DELETE', `/api/backends/host-sign-in/${encodeURIComponent(params.backend)}`);
}
