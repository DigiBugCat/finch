import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import SightingLog from '@/components/fieldguide/SightingLog';
import PrivacyAndDataHandling from '@/app/docs/privacy/page';

describe('customer-facing privacy copy', () => {
  it('states the ordinary relay boundary without claiming E2EE', () => {
    // The landing's sighting log is where the relay boundary is stated.
    render(<SightingLog />);

    const lede = screen.getByText(/Bodies pass through and are never stored/i);
    expect(lede).toHaveTextContent(/encrypted on both hops/i);
    expect(lede).toHaveTextContent(/Cloudflare decrypts it at its edge/i);
    expect(lede).toHaveTextContent(/finch is not end-to-end encrypted/i);
    expect(screen.getByRole('link', { name: 'The full privacy boundary' })).toHaveAttribute('href', '/docs/privacy');
    // Every logged call shows its body as not kept.
    const rows = screen.getAllByRole('row').slice(1); // minus the header row
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveTextContent(/not kept$/);
    expect(screen.queryByText(/never sees/i)).toBeNull();
  });

  it('documents the complete transport and retention boundary', () => {
    render(<PrivacyAndDataHandling />);

    expect(screen.getByText(/finch is not end-to-end encrypted/i)).toBeInTheDocument();
    expect(screen.getByText(/does not log or persist those bodies/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Operational metadata we retain/i })).toBeInTheDocument();
    // Test Chat (the one path that sent payloads to a hosted model) is gone;
    // the page must not keep describing it as available.
    expect(screen.queryAllByText(/Test Chat/i)).toHaveLength(0);
    expect(screen.queryAllByText(/Workers AI/i)).toHaveLength(0);
  });

  it('says why the call record exists, and it is something the owner can actually see', () => {
    render(<PrivacyAndDataHandling />);
    // The record is justified by `finch logs`, which shows it; the old
    // "service health" rationale pointed at a dashboard that no longer exists.
    const why = screen.getByText(/keeps a short record of each call/i);
    expect(why).toHaveTextContent(/finch logs <name>/);
    expect(screen.queryByText(/service health/i)).toBeNull();
  });

  it('keeps the legacy-migration note short, last, and out of the way', () => {
    const { container } = render(<PrivacyAndDataHandling />);
    // The team-features purge is a footnote for old accounts, not the page's
    // longest paragraph: it sits under its own dated heading at the end.
    const heading = screen.getByRole('heading', { name: 'Accounts from before September 2026' });
    const note = heading.nextElementSibling!;
    expect(note).toHaveTextContent(/team features/);
    expect(note).toHaveTextContent(/deleted the first time finch handles a request/);
    expect(note.textContent!.split(/\s+/).length).toBeLessThan(70);
    const paragraphs = [...container.querySelectorAll('p')];
    const longest = paragraphs.reduce((a, b) => (b.textContent!.length > a.textContent!.length ? b : a));
    expect(longest).not.toBe(note);
    // Nothing between the heading and the end but this note and the page nav.
    expect(note.nextElementSibling).toHaveClass('docs-foot');
    // The retired wording that the records are still stored must be gone.
    expect(screen.queryAllByText(/still stored/i)).toHaveLength(0);
    expect(screen.queryAllByText(/ask for them to be deleted/i)).toHaveLength(0);
  });
});
