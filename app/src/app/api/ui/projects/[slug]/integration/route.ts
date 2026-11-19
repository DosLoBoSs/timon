/**
 * Same-origin proxy to a project's landing setting. Read: the screen names
 * the GitHub account a publication would be made as. Write: only whether
 * Timon may resolve a contributor's conflict (`contributor_conflicts`), the
 * one field the screen changes; every other field is written through the
 * project's own route, and anything else in the body is dropped here.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('GET', `/api/projects/${encodeURIComponent(params.slug)}/integration`);
}

/** The daemon refuses `resolve` from anyone but a signed-in person. */
export async function PUT(req: Request, { params }: Ctx): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { contributor_conflicts?: unknown };
  return proxyJson('PUT', `/api/projects/${encodeURIComponent(params.slug)}/integration`, {
    contributor_conflicts: body.contributor_conflicts,
  });
}
