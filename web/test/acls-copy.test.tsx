import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import Acls from '@/app/docs/acls/page';

describe('access-control docs', () => {
  it('describes service-scoped keys as the whole policy', () => {
    const { container } = render(<Acls />);

    expect(screen.getByText(/no teams, groups,\s+shared members, or access-control rules/i)).toBeInTheDocument();
    expect(screen.getByText(/scope is the only thing\s+that decides what it reaches/i)).toBeInTheDocument();
    expect(screen.getByText(/signed in as you, the account.s owner/i)).toBeInTheDocument();
    // No retired sharing vocabulary or commands.
    const text = container.textContent ?? '';
    for (const retired of [/finch acl/i, /invite/i, /workspace/i, /organi[sz]ation/i, /group rule/i]) {
      expect(text).not.toMatch(retired);
    }
  });
});
