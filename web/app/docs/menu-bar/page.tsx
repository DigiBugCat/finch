import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Menu bar | finch docs',
  description:
    'finch-bar puts finch in your macOS menu bar or Linux panel: see which services are online, copy a URL, test a service, and start or stop the background service.',
};

const RELEASES = 'https://github.com/DigiBugCat/finch/releases/latest';

// Code blocks render HTML (for the comment and output spans), so the text in
// them must already be escaped.
function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function MenuBar() {
  return (
    <>
      <h1>Menu bar</h1>
      <p className="docs-lede">
        finch-bar puts finch in your macOS menu bar or Linux panel. At a glance you
        can see whether your services are online, then copy a service&apos;s URL, test
        it, or start and stop the background service without opening a terminal. It
        is optional: finch-bar runs the finch command-line tool for everything it
        shows and does, so it never does anything finch can&apos;t.
      </p>

      <h2>Install on macOS</h2>
      <p>
        Open the <a href={RELEASES}>latest release</a> and download{' '}
        <code>finch-bar-darwin-universal.zip</code>, or{' '}
        <code>finch-bar-darwin-universal-unsigned.zip</code> if that is the only one
        listed. Unzip it, move <code>finch-bar.app</code> to your Applications folder
        and open it. The same app runs on Apple silicon and Intel Macs with macOS 11
        or later. It lives in the menu bar only, with no Dock icon. From a terminal:
      </p>
      <Code>{`cd "$(mktemp -d)"
curl -fsSLO ${RELEASES}/download/finch-bar-darwin-universal.zip ||
  curl -fsSLO ${RELEASES}/download/finch-bar-darwin-universal-unsigned.zip
ditto -x -k finch-bar-darwin-universal*.zip /Applications
open /Applications/finch-bar.app`}</Code>
      <div className="docs-note">
        <b>Both downloads fail?</b> The Mac build is published a little after the rest
        of a release, once Apple has checked it. Try again in half an hour, or pick an
        earlier release from the <a href={RELEASES.replace(/\/latest$/, '')}>releases page</a>.
      </div>
      <div className="docs-note">
        <b>Got the -unsigned.zip?</b> That build is not notarized by Apple, so macOS
        refuses to open it when it came from a browser. Clear the download flag once
        with <code>xattr -dr com.apple.quarantine /Applications/finch-bar.app</code>.
      </div>

      <h2>Install on Linux</h2>
      <p>
        Builds are available for 64-bit Intel/AMD (<code>amd64</code>) and 64-bit ARM
        (<code>arm64</code>). This installs finch-bar for your user and starts it:
      </p>
      <Code>{`arch=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
curl -fsSL "${RELEASES}/download/finch-bar-linux-$arch.tar.gz" | tar -xz
cd "finch-bar-linux-$arch"
install -Dm755 finch-bar ~/.local/bin/finch-bar
install -Dm644 finch-bar.png ~/.local/share/icons/hicolor/256x256/apps/finch-bar.png
mkdir -p ~/.local/share/applications
sed "s|^Exec=.*|Exec=$HOME/.local/bin/finch-bar|" finch-bar.desktop \\
  &gt; ~/.local/share/applications/finch-bar.desktop
~/.local/bin/finch-bar &amp;`}</Code>
      <p>
        The commands use the full path because <code>~/.local/bin</code> is often not
        on your <code>PATH</code> until you next log in.
      </p>

      <h2>Open it at login</h2>
      <p>
        Turn on <b>Open finch-bar at login</b> in its menu, or run:
      </p>
      <Code>{`<span class="c"># macOS</span>
/Applications/finch-bar.app/Contents/MacOS/finch-bar --install-login-item
/Applications/finch-bar.app/Contents/MacOS/finch-bar --uninstall-login-item
<span class="c"># Linux</span>
~/.local/bin/finch-bar --install-login-item     <span class="c"># open finch-bar when you log in</span>
~/.local/bin/finch-bar --uninstall-login-item   <span class="c"># stop opening it at login</span>`}</Code>
      <p>
        On macOS this writes a LaunchAgent at{' '}
        <code>~/Library/LaunchAgents/com.finchmcp.finch-bar.plist</code>; on Linux, an
        autostart entry at <code>~/.config/autostart/finch-bar.desktop</code>. It takes
        effect the next time you log in. This is separate from finch&apos;s own
        background service, which keeps your services online whether or not finch-bar
        is running.
      </p>

      <h2>Requirements</h2>
      <ul>
        <li>
          <b>finch 1.7.0 or later</b> on the same machine. With finch 1.8.0 or later the
          menu also shows each service&apos;s URL. finch-bar looks for{' '}
          <code>finch</code> on your <code>PATH</code>, then in{' '}
          <code>~/.local/bin</code>, <code>/usr/local/bin</code> and{' '}
          <code>/opt/homebrew/bin</code>. To use another copy, start it with{' '}
          <code>finch-bar --finch /path/to/finch</code> or set{' '}
          <code>FINCH_BAR_FINCH</code>.
        </li>
        <li><b>macOS:</b> macOS 11 (Big Sur) or later.</li>
        <li>
          <b>Linux:</b> a panel with AppIndicator (StatusNotifierItem) support. KDE
          Plasma has it built in. <b>GNOME needs the &ldquo;AppIndicator and
          KStatusNotifierItem Support&rdquo; extension</b>; Ubuntu&apos;s desktop ships
          with it turned on. On other desktops, look for a system tray or
          StatusNotifierItem option in the panel settings. <b>Copy URL</b> uses{' '}
          <code>wl-copy</code> (Wayland) or <code>xclip</code> or <code>xsel</code> (X11),
          and notifications use <code>notify-send</code> when it is installed.
        </li>
      </ul>

      <h2>What it shows</h2>
      <p>
        The first line of the menu says how things are. It is the most urgent of
        these:
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Status line</th><th>What it means and what to do</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>finch isn&apos;t installed</td>
              <td>finch-bar can&apos;t find finch. <b>Copy install command</b> copies the installer one-liner.</td>
            </tr>
            <tr>
              <td>finch 1.6.0 is too old</td>
              <td>finch-bar needs finch 1.7.0 or later. Choose <b>Update finch</b>.</td>
            </tr>
            <tr>
              <td>Not signed in</td>
              <td>
                <b>Sign in…</b> opens finchmcp.com in your browser and waits while you approve,
                just like <code>finch login</code>.
              </td>
            </tr>
            <tr>
              <td>Waiting for you to approve sign-in</td>
              <td>A sign-in is waiting in the browser. Approve it there, or choose <b>Cancel sign-in</b>.</td>
            </tr>
            <tr>
              <td>Can&apos;t reach finch</td>
              <td>This machine can&apos;t reach finchmcp.com. finch-bar keeps trying, less often the longer it lasts.</td>
            </tr>
            <tr>
              <td>Background service isn&apos;t installed</td>
              <td>
                This machine has services to serve but they aren&apos;t online.{' '}
                <b>Start background service</b> runs <code>finch service install</code>.
              </td>
            </tr>
            <tr>
              <td>Background service stopped</td>
              <td>It is installed but not running. Start it again, or choose <b>Open log</b> to see why it stopped.</td>
            </tr>
            <tr>
              <td>No services yet</td>
              <td>
                Nothing is published on your account. Add one with{' '}
                <code>finch add &lt;name&gt; --service &lt;url&gt;</code>.
              </td>
            </tr>
            <tr>
              <td>1 of 3 services offline</td>
              <td>The next line names them. A service is offline when no machine serving it is connected.</td>
            </tr>
            <tr>
              <td>notes is waiting for approval</td>
              <td>
                A machine joined to serve it and waits for you to approve it. Run{' '}
                <code>finch approve notes</code>; the service&apos;s <b>Copy approve command</b> copies it.
              </td>
            </tr>
            <tr>
              <td>All connected</td>
              <td>Every service on your account is online.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The icon says the same thing without words. On macOS, a plain finch means all
        is well, a ring means something is in progress or waiting for you, a dot means
        something needs attention, and a faded finch means finch isn&apos;t set up yet.
        On Linux the dot is green, ochre or red.
      </p>
      <p>Below the status, each service on your account has its own submenu:</p>
      <ul>
        <li><b>This machine → &lt;local URL&gt;</b>, when this machine serves it.</li>
        <li><b>Copy URL</b> copies its public URL (finch 1.8.0 or later).</li>
        <li><b>Copy approve command</b>, when it is waiting for approval.</li>
        <li><b>Test</b> runs <code>finch test &lt;name&gt;</code> and shows the result, with a notification.</li>
        <li><b>Open in fleet page</b> opens the service on finchmcp.com.</li>
      </ul>

      <h2>What each item runs</h2>
      <p>
        finch-bar keeps no credentials and reads no finch files. Each item runs one
        finch command, the same one you could type:
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Menu item</th><th>finch command</th></tr>
          </thead>
          <tbody>
            <tr><td>The status line and services (every 10 seconds, and when you open the menu)</td><td><code>finch status --json</code>, then <code>finch fleet --json</code> when signed in</td></tr>
            <tr><td>Sign in…</td><td><code>finch login --start --json</code>, then <code>finch login --poll --json</code> until you approve</td></tr>
            <tr><td>Cancel sign-in</td><td><code>finch login --cancel --json</code></td></tr>
            <tr><td>Test</td><td><code>finch test &lt;name&gt; --json</code></td></tr>
            <tr><td>Start background service</td><td><code>finch service install --json</code></td></tr>
            <tr><td>Stop background service</td><td><code>finch service uninstall --json</code></td></tr>
            <tr><td>Open log</td><td><code>finch service status --json</code>, then opens <code>~/.finch/finch.log</code> (macOS) or the last 500 lines of <code>journalctl --user -u finch.service</code> (Linux)</td></tr>
            <tr><td>Check for updates</td><td><code>finch update --json</code></td></tr>
          </tbody>
        </table>
      </div>
      <p>
        When a command keeps failing, for example while you&apos;re offline, finch-bar
        waits longer between tries, up to five minutes. Quitting finch-bar doesn&apos;t
        stop your services; the background service keeps running. To see what the menu
        would show from a terminal (handy on a machine without a desktop), run{' '}
        <code>finch-bar --print</code>.
      </p>

      <h2>Remove it</h2>
      <p>Quit it from its menu first, then:</p>
      <Code>{`<span class="c"># macOS</span>
rm -f ~/Library/LaunchAgents/com.finchmcp.finch-bar.plist
rm -rf /Applications/finch-bar.app
<span class="c"># Linux</span>
~/.local/bin/finch-bar --uninstall-login-item
rm ~/.local/bin/finch-bar ~/.local/share/applications/finch-bar.desktop \\
   ~/.local/share/icons/hicolor/256x256/apps/finch-bar.png`}</Code>
      <p>
        The first line on each removes the login item, if you turned it on.
        Removing finch-bar leaves finch, your services and your sign-in as they were.
        To learn more about the background service it controls, see{' '}
        <Link href="/docs/services">Services</Link>.
      </p>
    </>
  );
}
