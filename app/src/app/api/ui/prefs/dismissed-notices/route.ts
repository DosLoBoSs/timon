import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The notices the signed-in account closed for good (docs/NOTICES.md). Session cookie only, like every proxy route. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/prefs/dismissed-notices');
}

/** Body: { id: '<pluginId>:<noticeId>' } — one key, validated by the daemon. */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/prefs/dismissed-notices', body);
}
