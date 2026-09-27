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

function fixture({ badChecksum = false } = {}) {
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
  writeFileSync(join(root, "checksums.txt"), ASSETS.map((a) => `${sha}  finch-${a}\n`).join(""));

  // Strict fake curl: only `curl -fsSL <url> -o <file>` for the two release
  // URLs; anything else fails like a 404 would.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != -fsSL ] || [ "$3" != -o ]; then echo "fake curl: bad argv: $*" >&2; exit 2; fi
case "$2" in
  "${HUB}/releases/checksums.txt") cp "${root}/checksums.txt" "$4" ;;
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
function run(fx, env = {}, { systemWritable = false } = {}) {
  chmodSync(fx.system, systemWritable ? 0o755 : 0o555);
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
