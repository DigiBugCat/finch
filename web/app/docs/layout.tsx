import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import DocsSidebar from './sidebar';
import './docs.css';

export const metadata: Metadata = {
  title: 'Finch docs',
  description: 'How to put your MCP services online with Finch: install, add a service, manage keys and access.',
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <div className="docs-shell">
        <DocsSidebar />
        <main className="docs-main">{children}</main>
      </div>
      <Footer />
    </>
  );
}
