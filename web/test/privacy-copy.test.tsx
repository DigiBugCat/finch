import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import Safety from '@/components/Safety';
import PrivacyAndDataHandling from '@/app/docs/privacy/page';

describe('customer-facing privacy copy', () => {
  it('states the ordinary relay boundary without claiming E2EE', () => {
    render(<Safety />);

    expect(screen.getByText("Payloads aren't retained")).toBeInTheDocument();
    expect(screen.getByText(/handled in memory while Finch relays them/i)).toBeInTheDocument();
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
    expect(note).toHaveTextContent(/keys minted by anyone other than the\s+account owner are revoked/i);
    // The retired wording that the records are still stored must be gone.
    expect(screen.queryAllByText(/still stored/i)).toHaveLength(0);
    expect(screen.queryAllByText(/ask for them to be deleted/i)).toHaveLength(0);
  });
});
