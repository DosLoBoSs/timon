import { createElement, useMemo, type ReactNode } from 'react';
import { parseRoleSvg, type RoleSvgNode } from '@/lib/roles';

function renderNodes(nodes: RoleSvgNode[], prefix: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${prefix}${i}`;
    return createElement(n.tag, { key, ...n.attrs }, ...renderNodes(n.children, `${key}.`));
  });
}

/**
 * A role icon (24×24, stroke-based) drawn from its parsed shapes, so the
 * markup stored with a custom role is never handed to the DOM as HTML.
 * Markup outside the grammar draws an empty frame.
 */
export function RoleSvg({ svg, className, size }: { svg: string | undefined; className?: string; size?: number }) {
  const nodes = useMemo(() => parseRoleSvg(svg ?? '') ?? [], [svg]);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {renderNodes(nodes, '')}
    </svg>
  );
}
