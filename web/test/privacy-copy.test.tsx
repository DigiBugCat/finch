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

    expect(screen.getByText(/Finch is not end-to-end encrypted/i)).toBeInTheDocument();
    expect(screen.getByText(/does not log or persist those bodies/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Operational metadata we retain/i })).toBeInTheDocument();
    // Test Chat (the one path that sent payloads to a hosted model) is gone;
    // the page must not keep describing it as available.
    expect(screen.queryAllByText(/Test Chat/i)).toHaveLength(0);
    expect(screen.queryAllByText(/Workers AI/i)).toHaveLength(0);
  });

  it('says legacy sharing records are deleted on migration, not kept', () => {
    render(<PrivacyAndDataHandling />);

    // The hub's single-user migration purges pre-cut member, ACL and
    // access-request rows (with their emails) and revokes other people's keys.
    const note = screen.getByText(/earlier sharing features/i);
    expect(note).toHaveTextContent(/deleted on migration/i);
    expect(note).toHaveTextContent(/team members and invitations/i);
    expect(note).toHaveTextContent(/access-control rules/i);
    expect(note).toHaveTextContent(/access requests/i);
    expect(note).toHaveTextContent(/email addresses/i);
    // Nothing records who minted a key or enrolled a box, so the page must not
    // promise that only other people's keys go when others could sign in.
    expect(note).toHaveTextContent(
      /if anyone besides the account owner could sign\s+in to the account, every access key, connected box and CLI login is\s+revoked/i,
    );
    expect(note).toHaveTextContent(/only access keys labelled for\s+someone else are revoked/i);
    expect(note).not.toHaveTextContent(/keys minted by anyone other than/i);
    // The retired wording that the records are still stored must be gone.
    expect(screen.queryAllByText(/still stored/i)).toHaveLength(0);
    expect(screen.queryAllByText(/ask for them to be deleted/i)).toHaveLength(0);
  });
});
