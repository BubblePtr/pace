import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publishScript = fileURLToPath(new URL("./publish-release.sh", import.meta.url));

const releaseAssets = (version) => {
  const artifact = `Pace-${version}-arm64.dmg`;
  const zipArtifact = `Pace-${version}-arm64.zip`;
  return {
    artifact,
    zipArtifact,
    files: [artifact, zipArtifact, `${zipArtifact}.blockmap`, "latest-mac.yml", "SHA256SUMS.txt"],
  };
};

function runPublish(t, { existing = null, fail = "", prerelease = false, omit = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pigui-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "dist"));
  const version = prerelease ? "0.0.1-rc.1" : "0.0.1";
  const { artifact, files } = releaseAssets(version);
  for (const file of files) {
    if (file !== omit) writeFileSync(join(dir, "dist", file), `verified-test-${file}`);
  }
  const callsFile = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "bin", "gh"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n');
const operation = args[0] === 'api' ? 'api' : args.slice(0, 2).join(' ');
if (process.env.FAIL_OPERATION === operation) process.exit(1);
if (operation === 'api') {
  const existing = JSON.parse(process.env.EXISTING_RELEASE);
  process.stdout.write(JSON.stringify(existing === null ? [] : [{ tag_name: process.env.RELEASE_TAG, draft: existing }]));
} else if (operation === 'release view') {
  process.stdout.write('Release: https://github.com/BubblePtr/pace/releases/tag/' + process.env.RELEASE_TAG + '\\n');
} else if (!['release create', 'release upload', 'release edit'].includes(operation)) process.exit(2);
`, { mode: 0o755 });
  const result = spawnSync("bash", [publishScript], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      CALLS_FILE: callsFile,
      EXISTING_RELEASE: JSON.stringify(existing),
      FAIL_OPERATION: fail,
      GH_REPO: "BubblePtr/pace",
      RELEASE_TAG: `v${version}`,
      VERSION: version,
      PRERELEASE: String(prerelease),
      DMG_NAME: artifact,
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    },
  });
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line))
    : [];
  return { result, calls, artifact, files };
}

function assertUploadedAssets(args, files) {
  for (const file of files) {
    assert.ok(args.includes(`dist/${file}`), `missing dist/${file} in ${args.join(" ")}`);
  }
}

// Assets upload one call each, in parallel, so coverage is asserted across
// the whole set of upload invocations rather than a single command line.
function assertParallelUploads(calls, files) {
  const uploads = calls.filter(args => args[1] === "upload");
  assert.equal(uploads.length, files.length, `expected ${files.length} upload calls in ${JSON.stringify(calls)}`);
  assert.ok(uploads.every(args => args.includes("--clobber")), "every upload should clobber");
  assertUploadedAssets(uploads.flat(), files);
}

test("a stable release is published only after every required asset reaches its draft", t => {
  const { result, calls, files } = runPublish(t);
  assert.equal(result.status, 0, result.stderr);
  const create = calls.find(args => args[1] === "create");
  assert.ok(create.includes("--draft"));
  assertParallelUploads(calls, files);
  const edit = calls.find(args => args[1] === "edit");
  assert.ok(edit.includes("--draft=false"));
  assert.ok(edit.includes("--prerelease=false"));
  assert.ok(edit.includes("--latest=true"));
  assert.ok(calls.indexOf(edit) > calls.indexOf(create));
});

test("a prerelease is published without becoming the latest stable release", t => {
  const { result, calls } = runPublish(t, { prerelease: true });
  assert.equal(result.status, 0, result.stderr);
  const edit = calls.find(args => args[1] === "edit");
  assert.ok(edit.includes("--prerelease=true"));
  assert.ok(edit.includes("--latest=false"));
});

test("an existing draft keeps its notes while its assets are updated and published", t => {
  const { result, calls, files } = runPublish(t, { existing: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!calls.some(args => args[1] === "create"));
  assertParallelUploads(calls, files);
  const edit = calls.find(args => args[1] === "edit");
  assert.ok(edit.includes("--draft=false"));
  assert.ok(!edit.some(arg => arg.startsWith("--notes")));
});

test("an already published version is immutable", t => {
  const { result, calls } = runPublish(t, { existing: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /already published/);
  assert.ok(!calls.some(args => args[0] === "release"));
});

test("failed asset upload leaves an existing draft unpublished", t => {
  const { result, calls } = runPublish(t, { existing: true, fail: "release upload" });
  assert.notEqual(result.status, 0);
  assert.ok(calls.some(args => args[1] === "upload"));
  assert.ok(!calls.some(args => args[1] === "edit"));
});

test("API failures cannot be mistaken for a missing release", t => {
  const { result, calls } = runPublish(t, { fail: "api" });
  assert.notEqual(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "api");
});

test("missing any required asset exits before the release is published", t => {
  for (const omit of releaseAssets("0.0.1").files) {
    const { result, calls } = runPublish(t, { omit });
    assert.notEqual(result.status, 0, `expected a failure when ${omit} is missing`);
    assert.ok(!calls.some(args => args[0] === "release"), `gh release ran despite missing ${omit}`);
  }
});
