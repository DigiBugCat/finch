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
});
