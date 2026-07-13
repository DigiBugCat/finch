import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsersView } from "@/components/dash/users";

const active = { id:"m_admin", name:"Admin", email:"admin@example.com", role:"Admin", status:"active" };

describe("UsersView membership removal",()=>{
  it("preserves grants by default and forwards an explicit revoke choice",()=>{
    const onRemove=vi.fn();
    const first=render(<UsersView users={[active]} onInvite={vi.fn()} onRole={vi.fn()} onRemove={onRemove} onEnable={vi.fn()}/>);
    fireEvent.click(screen.getByText("remove"));
    fireEvent.click(screen.getByText("confirm"));
    expect(onRemove).toHaveBeenLastCalledWith("m_admin",false);
    first.unmount();
    render(<UsersView users={[active]} onInvite={vi.fn()} onRole={vi.fn()} onRemove={onRemove} onEnable={vi.fn()}/>);
    fireEvent.click(screen.getByText("remove"));
    fireEvent.click(screen.getByLabelText("Also revoke service grants"));
    fireEvent.click(screen.getByText("confirm"));
    expect(onRemove).toHaveBeenLastCalledWith("m_admin",true);
  });
});
