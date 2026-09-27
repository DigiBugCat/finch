// Runs the hub's `curl -fsSL https://finchmcp.com/install | sh` installer
// (worker/src/install-script.ts) under a real POSIX shell with a fake curl and
// a fake sudo on PATH. An AI agent runs this line unattended, so the contract
// is: never prompt (no sudo, no stdin), install to /usr/local/bin only when it
// is writable, else ~/.local/bin with a PATH hint, honour FINCH_INSTALL_DIR,
// and refuse a binary whose checksum does not match.
//
// Node strips the TypeScript types on import (Node >= 22.18).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installScript } from "../worker/src/install-script.ts";

const HUB = "https://hub.example";
const ASSETS = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "linux-armv6", "linux-armv7"];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// manifest: undefined writes the normal checksums.txt, null serves none (a
// 404), and a function (sha) => text writes that text.
function fixture({ badChecksum = false, manifest } = {}) {
  const root = mkdtempSync(join(tmpdir(), "finch-install-"));
  const bin = join(root, "fakebin");
  const home = join(root, "home");
  const system = join(root, "usr-local-bin");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(system);
  const binary = "#!/bin/sh\necho fake-finch\n";
  writeFileSync(join(root, "binary"), binary);
  const sha = badChecksum ? "0".repeat(64) : createHash("sha256").update(binary).digest("hex");
  if (manifest === undefined) {
    writeFileSync(join(root, "checksums.txt"), ASSETS.map((a) => `${sha}  finch-${a}\n`).join(""));
  } else if (manifest !== null) {
    writeFileSync(join(root, "checksums.txt"), manifest(sha));
  }

  // Strict fake curl: only `curl -fsSL <url> -o <file>` for the two release
  // URLs; anything else fails like a 404 would.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != -fsSL ] || [ "$3" != -o ]; then echo "fake curl: bad argv: $*" >&2; exit 2; fi
case "$2" in
  "${HUB}/releases/checksums.txt") cp "${root}/checksums.txt" "$4" 2>/dev/null || { echo "fake curl: 404 $2" >&2; exit 22; } ;;
  "${HUB}/releases/finch-darwin-"*|"${HUB}/releases/finch-linux-"*) cp "${root}/binary" "$4" ;;
  *) echo "fake curl: 404 $2" >&2; exit 22 ;;
esac
`,
  );
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho called > "${root}/sudo-called"\nexit 1\n`);
  chmodSync(join(bin, "curl"), 0o755);
  chmodSync(join(bin, "sudo"), 0o755);
  return { root, bin, home, system };
}

// run executes the installer with /usr/local/bin redirected to a test-owned
// directory, stdin closed, and a minimal PATH.
function run(fx, env = {}, { systemWritable = false, systemMode } = {}) {
  chmodSync(fx.system, systemMode ?? (systemWritable ? 0o755 : 0o555));
  const script = installScript(HUB).replaceAll("/usr/local/bin", fx.system);
  const res = spawnSync("sh", ["-c", script], {
    env: { HOME: fx.home, PATH: `${fx.bin}:/usr/bin:/bin`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 20_000,
  });
  chmodSync(fx.system, 0o755);
  return res;
}

function assertInstalled(path) {
  assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\necho fake-finch\n");
  assert.ok(statSync(path).mode & 0o100, `${path} is not executable`);
}

test("installs to the system dir when it is writable", () => {
  const fx = fixture();
  const res = run(fx, { PATH: `${fx.bin}:${fx.system}:/usr/bin:/bin` }, { systemWritable: true });
  assert.equal(res.status, 0, res.stderr);
  assertInstalled(join(fx.system, "finch"));
  assert.doesNotMatch(res.stdout, /not on your PATH/);
  assert.doesNotMatch(res.stdout, /shadows/);
  assert.match(res.stdout, /^ {2}Next: {2}finch login --start/m);
  assert.match(res.stdout, /https:\/\/finchmcp\.com\/agents\.md/);
  assert.ok(!existsSync(join(fx.root, "sudo-called")));
});

test("falls back to ~/.local/bin without sudo and prints a PATH hint", { skip: isRoot && "root can write anywhere" }, () => {
  const fx = fixture();
  const res = run(fx);
  assert.equal(res.status, 0, res.stderr);
  const target = join(fx.home, ".local", "bin", "finch");
  assertInstalled(target);
  assert.ok(!existsSync(join(fx.system, "finch")));
  assert.ok(!existsSync(join(fx.root, "sudo-called")), "the installer called sudo");
  assert.match(res.stdout, /is not on your PATH/);
  assert.match(res.stdout, new RegExp(`export PATH="${join(fx.home, ".local", "bin")}:\\$PATH"`));
  // The next steps use the full path, since `finch` is not on PATH yet.
  assert.ok(res.stdout.includes(`${target} login --start`));
});

test("warns when an older finch earlier on PATH shadows the new one", { skip: isRoot && "root can write anywhere" }, () => {
  const fx = fixture();
  // A previous install left a root-owned copy in a directory that comes first.
  const old = join(fx.root, "old-bin");
  mkdirSync(old);
  writeFileSync(join(old, "finch"), "#!/bin/sh\necho old-finch\n");
  chmodSync(join(old, "finch"), 0o755);
  const local = join(fx.home, ".local", "bin");
  const res = run(fx, { PATH: `${fx.bin}:${old}:${local}:/usr/bin:/bin` });
  assert.equal(res.status, 0, res.stderr);
  const target = join(local, "finch");
  assertInstalled(target);
  assert.doesNotMatch(res.stdout, /not on your PATH/);
  assert.ok(res.stdout.includes(`'finch' on your PATH is ${join(old, "finch")}`), res.stdout);
  // The next steps name the new binary, not the shadowing one.
  assert.ok(res.stdout.includes(`Next:  ${target} login --start`), res.stdout);
  assert.equal(readFileSync(join(old, "finch"), "utf8"), "#!/bin/sh\necho old-finch\n");
});

test("a symlinked PATH entry to the install dir is not a shadow", () => {
  const fx = fixture();
  const custom = join(fx.root, "custom");
  mkdirSync(custom);
  const link = join(fx.root, "link-to-custom");
  symlinkSync(custom, link);
  const res = run(fx, { FINCH_INSTALL_DIR: custom, PATH: `${fx.bin}:${link}:/usr/bin:/bin` });
  assert.equal(res.status, 0, res.stderr);
  assertInstalled(join(custom, "finch"));
  assert.doesNotMatch(res.stdout, /shadows/);
});

test("FINCH_INSTALL_DIR wins over both defaults", () => {
  const fx = fixture();
  const custom = join(fx.root, "custom", "bin");
  const res = run(fx, { FINCH_INSTALL_DIR: custom }, { systemWritable: true });
  assert.equal(res.status, 0, res.stderr);
  assertInstalled(join(custom, "finch"));
  assert.ok(!existsSync(join(fx.system, "finch")));
});

// Another account that can write the install dir can swap the verified binary
// after its checksum check (or later), so such a directory is refused unless
// its sticky bit stops others from unlinking or renaming our files.
function sharedDir(fx, name, mode) {
  const dir = join(fx.root, name);
  mkdirSync(dir);
  chmodSync(dir, mode); // mkdirSync's mode is masked by the umask
  return dir;
}

function assertRefusedShared(res, dir) {
  assert.equal(res.status, 1, res.stdout);
  assert.ok(res.stderr.includes(`refusing to install into ${dir}: other users can write to it`), res.stderr);
  assert.match(res.stderr, /chmod go-w/);
  assert.ok(!existsSync(join(dir, "finch")));
  assert.deepEqual(readdirSync(dir), [], "temporary files were left behind");
}

test("a world-writable FINCH_INSTALL_DIR is refused before anything is downloaded", () => {
  const fx = fixture();
  const shared = sharedDir(fx, "shared", 0o777);
  const res = run(fx, { FINCH_INSTALL_DIR: shared });
  assertRefusedShared(res, shared);
  assert.doesNotMatch(res.stdout, /downloading/);
  assert.ok(!existsSync(join(fx.root, "sudo-called")));
});

test("a world-writable directory with the sticky bit is accepted", () => {
  const fx = fixture();
  const sticky = sharedDir(fx, "sticky", 0o1777);
  const res = run(fx, { FINCH_INSTALL_DIR: sticky });
  assert.equal(res.status, 0, res.stderr);
  assertInstalled(join(sticky, "finch"));
  assert.deepEqual(readdirSync(sticky), ["finch"]);
});

test("a group-writable directory is accepted only for your own user-private group", () => {
  const fx = fixture();
  const grp = sharedDir(fx, "group", 0o775);
  const [, , owner, group] = spawnSync("ls", ["-ld", `${grp}/.`], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } })
    .stdout.trim()
    .split(/\s+/);
  const me = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
  const res = run(fx, { FINCH_INSTALL_DIR: grp });
  if (owner === me && group === me) {
    assert.equal(res.status, 0, res.stderr);
    assertInstalled(join(grp, "finch"));
  } else {
    assertRefusedShared(res, grp);
  }
});

test("a system dir other users can write is skipped for ~/.local/bin", { skip: isRoot && "root can write anywhere" }, () => {
  const fx = fixture();
  const res = run(fx, {}, { systemMode: 0o777 });
  assert.equal(res.status, 0, res.stderr);
  assertInstalled(join(fx.home, ".local", "bin", "finch"));
  assert.ok(!existsSync(join(fx.system, "finch")));
});

test("an unwritable FINCH_INSTALL_DIR fails fast instead of escalating", { skip: isRoot && "root can write anywhere" }, () => {
  const fx = fixture();
  const locked = join(fx.root, "locked");
  mkdirSync(locked, { mode: 0o555 });
  const res = run(fx, { FINCH_INSTALL_DIR: locked });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot write to .*FINCH_INSTALL_DIR/);
  assert.ok(!existsSync(join(fx.root, "sudo-called")));
});

test("a checksum mismatch installs nothing", () => {
  const fx = fixture({ badChecksum: true });
  const custom = join(fx.root, "custom");
  const res = run(fx, { FINCH_INSTALL_DIR: custom });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /checksum mismatch/);
  assert.ok(!existsSync(join(custom, "finch")));
  // No temp files left behind next to the destination.
  assert.deepEqual(existsSync(custom) ? readdirSync(custom) : [], []);
});

test("a failed download installs nothing", () => {
  const fx = fixture();
  const custom = join(fx.root, "custom");
  const script = installScript("https://elsewhere.example");
  const res = spawnSync("sh", ["-c", script], {
    env: { HOME: fx.home, PATH: `${fx.bin}:/usr/bin:/bin`, FINCH_INSTALL_DIR: custom },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.notEqual(res.status, 0);
  assert.ok(!existsSync(join(custom, "finch")));
});

// With a SHA-256 tool present, verification fails closed: a manifest that is
// missing, empty, lacks this asset, or lists it twice installs nothing.
for (const [name, manifest, pattern] of [
  ["a missing checksums.txt", null, /could not fetch .*checksums\.txt/],
  ["an empty checksums.txt", () => "", /could not fetch .*checksums\.txt/],
  ["a checksums.txt without this asset", (sha) => `${sha}  finch-plan9-amd64\n`, /has 0 entries/],
  ["a checksums.txt listing the asset twice", (sha) => ASSETS.map((a) => `${sha}  finch-${a}\n${sha}  finch-${a}\n`).join(""), /has 2 entries/],
]) {
  test(`${name} installs nothing`, () => {
    const fx = fixture({ manifest });
    const custom = join(fx.root, "custom");
    const res = run(fx, { FINCH_INSTALL_DIR: custom });
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, pattern);
    assert.match(res.stderr, /not installing/);
    assert.ok(!existsSync(join(custom, "finch")));
    assert.deepEqual(existsSync(custom) ? readdirSync(custom) : [], []);
  });
}

test("a binary-mode (*asset) checksum entry is accepted", () => {
  const fx = fixture({ manifest: (sha) => ASSETS.map((a) => `${sha} *finch-${a}\n`).join("") });
  const custom = join(fx.root, "custom");
  const res = run(fx, { FINCH_INSTALL_DIR: custom });
  assert.equal(res.status, 0, res.stderr);
  assertInstalled(join(custom, "finch"));
});

// Without any SHA-256 tool there is nothing to verify with: it says so and
// installs (the manifest is not even fetched).
test("without a SHA-256 tool it warns and installs", () => {
  const fx = fixture({ manifest: null });
  const tools = join(fx.root, "tools");
  mkdirSync(tools);
  for (const tool of ["sh", "uname", "tr", "mkdir", "mktemp", "awk", "chmod", "mv", "rm", "cp", "dirname", "basename", "cat", "ls", "id"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found.startsWith("/"), `${tool} not found`);
    symlinkSync(found, join(tools, tool));
  }
  const custom = join(fx.root, "custom");
  const res = run(fx, { FINCH_INSTALL_DIR: custom, PATH: `${fx.bin}:${tools}` });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /without verifying its checksum/);
  assertInstalled(join(custom, "finch"));
});

// The download and checksum files are created with mktemp in the install
// directory (exclusive, unpredictable names; never a PID-derived path another
// user could pre-create as a symlink) and removed on success and failure.
test("temporary files come from mktemp in the install dir and are cleaned up", () => {
  const script = installScript(HUB);
  assert.doesNotMatch(script, /\$\$/, "a PID-derived temp path is predictable");
  for (const [name, opts, status] of [
    ["success", {}, 0],
    ["checksum mismatch", { badChecksum: true }, 1],
  ]) {
    const fx = fixture(opts);
    const log = join(fx.root, "mktemp.log");
    const realMktemp = spawnSync("sh", ["-c", "command -v mktemp"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(fx.bin, "mktemp"),
      `#!/bin/sh\nout="$("${realMktemp}" "$@")" || exit $?\nprintf '%s\\n' "$out" >> "${log}"\nprintf '%s\\n' "$out"\n`,
    );
    chmodSync(join(fx.bin, "mktemp"), 0o755);
    const custom = join(fx.root, "custom");
    mkdirSync(custom);
    // A symlink planted where a PID-derived name would have been is never used.
    const victim = join(fx.root, "victim");
    writeFileSync(victim, "precious\n");
    chmodSync(victim, 0o600);
    for (let pid = 1; pid < 64; pid++) symlinkSync(victim, join(custom, `.finch-install.${pid}`));
    const res = run(fx, { FINCH_INSTALL_DIR: custom });
    assert.equal(res.status, status, `${name}: ${res.stderr}`);
    const made = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(made.length, 2, `${name}: mktemp calls ${made}`);
    for (const p of made) {
      assert.equal(join(p, ".."), custom, `${name}: ${p} is not in the install dir`);
      assert.match(p.slice(custom.length + 1), /^\.finch-(install|checksums)\.[A-Za-z0-9]{8}$/);
      assert.ok(!existsSync(p), `${name}: ${p} was left behind`);
    }
    assert.equal(readFileSync(victim, "utf8"), "precious\n");
    assert.equal(statSync(victim).mode & 0o777, 0o600);
    const left = readdirSync(custom).filter((f) => !f.startsWith(".finch-install."));
    assert.deepEqual(left, status === 0 ? ["finch"] : [], name);
  }
});
