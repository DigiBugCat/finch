import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { checkDurableObjectMigrations } from "./do-migrations.mjs";
import { readJsonc } from "./jsonc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const history = () => [
  { tag: "v1", new_sqlite_classes: ["ApplianceDO"] },
  { tag: "v2", new_sqlite_classes: ["TenantDO"] },
  { tag: "v3", new_sqlite_classes: ["RouterDO"] },
  { tag: "v4", renamed_classes: [{ from: "ApplianceDO", to: "BoxDO" }] },
  { tag: "v5", new_sqlite_classes: ["AviaryEnrollmentDO"] },
  { tag: "v6", new_sqlite_classes: ["DirectoryDO"] },
];
const v7 = () => ({ tag: "v7", deleted_classes: ["AviaryEnrollmentDO", "DirectoryDO"] });
const bindings = () => ({
  bindings: [
    { name: "BOX", class_name: "BoxDO" },
    { name: "TENANT", class_name: "TenantDO" },
    { name: "ROUTER", class_name: "RouterDO" },
  ],
});
const env = (migrations, durable_objects = bindings()) => ({ migrations, durable_objects });

test("every deployable env in wrangler.jsonc passes", () => {
  const cfg = readJsonc(join(root, "wrangler.jsonc"));
  assert.deepEqual(checkDurableObjectMigrations("top-level", cfg), []);
  for (const name of ["dev", "staging", "production"]) {
    assert.deepEqual(checkDurableObjectMigrations(name, cfg.env[name]), [], name);
  }
});

test("the test runtime config carries the same migrations", () => {
  const cfg = readJsonc(join(root, "test", "wrangler.test.jsonc"));
  assert.deepEqual(checkDurableObjectMigrations("test", cfg), []);
});

test("accepts the approved deletion in either class order, and later non-deleting migrations", () => {
  const reordered = { tag: "v7", deleted_classes: ["DirectoryDO", "AviaryEnrollmentDO"] };
  assert.deepEqual(checkDurableObjectMigrations("x", env([...history(), reordered])), []);
  const later = { tag: "v8", new_sqlite_classes: ["SomethingDO"] };
  assert.deepEqual(checkDurableObjectMigrations("x", env([...history(), v7(), later])), []);
});

test("refuses every other deleted_classes step", () => {
  const cases = [
    // another class deleted alongside the approved ones
    [...history(), { tag: "v7", deleted_classes: ["AviaryEnrollmentDO", "DirectoryDO", "TenantDO"] }],
    // only part of the approved deletion, under the approved tag
    [...history(), { tag: "v7", deleted_classes: ["DirectoryDO"] }],
    // the approved classes under a different tag
    [...history(), { tag: "v8", deleted_classes: ["AviaryEnrollmentDO", "DirectoryDO"] }],
    // the approved step plus a second, unapproved deletion
    [...history(), v7(), { tag: "v8", deleted_classes: ["BoxDO"] }],
    // the approved step smuggling another change in
    [...history(), { ...v7(), renamed_classes: [{ from: "TenantDO", to: "X" }] }],
    // deleted_classes that is not a list
    [...history(), { tag: "v7", deleted_classes: "AviaryEnrollmentDO,DirectoryDO" }],
  ];
  for (const migrations of cases) {
    const problems = checkDurableObjectMigrations("x", env(migrations));
    assert.ok(
      problems.some((p) => /deleted_classes/.test(p)),
      `expected a deleted_classes refusal for ${JSON.stringify(migrations.slice(6))}: ${problems}`,
    );
  }
});

test("requires the approved deletion, right after v6", () => {
  assert.ok(checkDurableObjectMigrations("x", env(history())).some((p) => /must include migration/.test(p)));
  const early = history();
  early.splice(5, 0, v7());
  assert.notDeepEqual(checkDurableObjectMigrations("x", env(early)), []);
});

test("refuses edits to the applied history", () => {
  for (const mutate of [
    (m) => m.splice(4, 1), // drop v5
    (m) => (m[5] = { tag: "v6", new_sqlite_classes: ["OtherDO"] }),
    (m) => m.reverse(),
  ]) {
    const migrations = [...history(), v7()];
    mutate(migrations);
    assert.ok(
      checkDurableObjectMigrations("x", env(migrations)).some((p) => /append-only/.test(p)),
      JSON.stringify(migrations),
    );
  }
});

test("refuses a binding to a deleted class", () => {
  for (const binding of [
    { name: "DIRECTORY", class_name: "DirectoryDO" },
    { name: "AVIARY_ENROLLMENT", class_name: "AviaryEnrollmentDO" },
  ]) {
    const durable = bindings();
    durable.bindings.push(binding);
    const problems = checkDurableObjectMigrations("x", env([...history(), v7()], durable));
    assert.ok(problems.some((p) => p.includes(binding.class_name)), binding.name);
  }
});
