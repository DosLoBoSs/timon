'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

export class PluginBoundary extends Component<{ pluginId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[plugin:${this.props.pluginId}] render failed`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{t('pluginHost.renderFailed', { id: this.props.pluginId })}</div>;
    }
    return this.props.children;
  }
}
