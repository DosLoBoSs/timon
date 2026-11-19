/**
 * Same-origin proxy to a project's landing setting, read only: the screen
 * names the GitHub account a publication would be made as. The setting is
 * written from the project's page, through its own route.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { slug: string } };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return proxyJson('GET', `/api/projects/${encodeURIComponent(params.slug)}/integration`);
}
