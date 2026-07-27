// Settings → CLI access is the highest-volume path for the ~30-day tenant-admin
// CLI token: every doc routes users to its copy button, and what lands on the
// clipboard gets pasted into a shell verbatim. It used to copy
// `finch login --hub <hub> <token>`, putting the credential on argv
// (/proc/<pid>/cmdline, world-readable) and into shell history. These tests pin
// the argv-free heredoc form on both the clipboard and the screen.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CliAccess } from "@/components/dash/settings";
import { cliLoginArgv, cliLoginCommand } from "@/lib/cli-login-command";

const HUB = "https://finchmcp.com";
const TOKEN = "cli_tenant_admin_0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cliLoginCommand", () => {
  it("keeps the token off the shell command line", () => {
    const cmd = cliLoginCommand(HUB, TOKEN);
    const [argv, body, terminator] = cmd.split("\n");

    expect(cmd.split("\n")).toHaveLength(3);
    expect(argv).not.toContain(TOKEN);
    expect(argv).toBe(`finch login --hub ${HUB} --token - <<'FINCH_CLI_TOKEN'`);
    // The token is delivered on stdin, which is what `--token -` reads.
    expect(body).toBe(TOKEN);
    expect(terminator).toBe("FINCH_CLI_TOKEN");
  });

  it("never renders the token in the displayed line", () => {
    expect(cliLoginArgv(HUB)).not.toContain(TOKEN);
  });
});

describe("Settings → CLI access", () => {
  it("copies the argv-free command and shows a token-free preview", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ hub: HUB, token: TOKEN }) })),
    );

    render(<CliAccess />);
    fireEvent.click(screen.getByRole("button", { name: "Generate CLI token" }));
    const copy = await screen.findByRole("button", { name: "Copy" });

    // Nothing on screen may carry the credential — the panel says the token is
    // shown only once, and screenshots/screen-shares of it are the point of the
    // redaction.
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.textContent).toContain(cliLoginArgv(HUB));

    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied: string = writeText.mock.calls[0][0];
    expect(copied).toBe(cliLoginCommand(HUB, TOKEN));
    // The regression guard proper: the token must not sit on the first line,
    // which is the only part a shell turns into argv.
    expect(copied.split("\n")[0]).not.toContain(TOKEN);
    expect(copied).toContain(TOKEN); // …but it is still actually delivered.
  });
});
