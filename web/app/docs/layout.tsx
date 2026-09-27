import type { Metadata } from 'next';
import SiteNav from '@/components/fieldguide/SiteNav';
import SiteFooter from '@/components/fieldguide/SiteFooter';
import DocsSidebar from './sidebar';
import './docs.css';

export const metadata: Metadata = {
  title: 'finch docs',
  description: 'How to put your MCP services online with finch: install, add a service, manage keys and access.',
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNav />
      <div className="iw-wrap docs-shell">
        <DocsSidebar />
        <main className="docs-main">{children}</main>
      </div>
      <SiteFooter />
    </>
  );
}
