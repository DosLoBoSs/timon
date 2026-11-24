import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The agent's extra folders have their own door on the daemon: the config
// route strips them, and only a person (or agents:privileged-config) writes them.
const path = (name: string): string => `/api/agents/${encodeURIComponent(name)}/extra-dirs`;

export async function GET(_req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('GET', path(params.name));
}

export async function PUT(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('PUT', path(params.name), await req.json().catch(() => ({})));
}

export async function POST(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('POST', path(params.name), await req.json().catch(() => ({})));
}

export async function DELETE(req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('DELETE', path(params.name), await req.json().catch(() => ({})));
}
