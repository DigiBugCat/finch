import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import Safety from '@/components/Safety';
import { ChatPanel } from '@/components/dash/ChatPanel';
import PrivacyAndDataHandling from '@/app/docs/privacy/page';

describe('customer-facing privacy copy', () => {
  it('states the ordinary relay boundary without claiming E2EE', () => {
    render(<Safety />);

    expect(screen.getByText("Payloads aren't retained")).toBeInTheDocument();
    expect(screen.getByText(/handled in memory while Finch relays them/i)).toBeInTheDocument();
    expect(screen.queryByText(/never sees/i)).toBeNull();
  });

  it('discloses Workers AI processing before Test Chat is used', () => {
    render(<ChatPanel service="calendar" online={true} />);

    const disclosure = screen.getByRole('note');
    expect(disclosure).toHaveTextContent('Cloudflare Workers AI processes this chat');
    expect(disclosure).toHaveTextContent('chat messages');
    expect(disclosure).toHaveTextContent('tool schemas');
    expect(disclosure).toHaveTextContent('tool arguments');
    expect(disclosure).toHaveTextContent('tool results');
    expect(disclosure).toHaveTextContent("Don't use Test Chat with sensitive data");
  });

  it('documents the complete transport and retention boundary', () => {
    render(<PrivacyAndDataHandling />);

    expect(screen.getByText(/Finch is not end-to-end encrypted/i)).toBeInTheDocument();
    expect(screen.getByText(/does not log or persist those bodies/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Operational metadata we retain/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Test Chat is a separate processing path/i })).toBeInTheDocument();
  });
});
