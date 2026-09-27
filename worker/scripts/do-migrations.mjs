// Durable Object migration guard, shared by deploy-preflight.mjs and its test.
//
// Wrangler migrations are append-only history, and a `deleted_classes` step
// permanently deletes every object of those classes along with its stored
// data. So a deploy must never carry a deletion by accident. Exactly one is
// allowed: v7, the owner-approved single-user migration that deletes the
// retired AviaryEnrollmentDO (created in v5) and DirectoryDO (created in v6).
// Any other deleted_classes step — a different tag, a different or extra
// class, or v7 carrying anything else — is refused.
//
// Wrangler does not inherit migrations or durable_objects from the top-level
// config into named environments, so the caller checks each env it deploys.

export const APPROVED_DELETION = Object.freeze({
  tag: "v7",
  deleted_classes: Object.freeze(["AviaryEnrollmentDO", "DirectoryDO"]),
});

// The history every environment must keep, in order, before v7.
const HISTORY = [
  { tag: "v1", new_sqlite_classes: ["ApplianceDO"] },
  { tag: "v2", new_sqlite_classes: ["TenantDO"] },
  { tag: "v3", new_sqlite_classes: ["RouterDO"] },
  { tag: "v4", renamed_classes: [{ from: "ApplianceDO", to: "BoxDO" }] },
  { tag: "v5", new_sqlite_classes: ["AviaryEnrollmentDO"] },
  { tag: "v6", new_sqlite_classes: ["DirectoryDO"] },
];

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isApprovedDeletion(migration) {
  if (!migration || typeof migration !== "object") return false;
  const keys = Object.keys(migration).sort();
  if (!sameJson(keys, ["deleted_classes", "tag"])) return false;
  if (migration.tag !== APPROVED_DELETION.tag) return false;
  const classes = migration.deleted_classes;
  return (
    Array.isArray(classes) &&
    sameJson([...classes].sort(), [...APPROVED_DELETION.deleted_classes].sort())
  );
}

/** Check one environment's `migrations` and `durable_objects` blocks. Returns
 *  a list of human-readable problems; an empty list means the env is sound. */
export function checkDurableObjectMigrations(envName, envCfg) {
  const problems = [];
  const where = `[env.${envName}]`;
  const migrations = Array.isArray(envCfg?.migrations) ? envCfg.migrations : [];

  HISTORY.forEach((expected, i) => {
    if (!sameJson(migrations[i], expected)) {
      problems.push(
        `${where} migration #${i + 1} must stay ${JSON.stringify(expected)} — applied migrations are append-only.`,
      );
    }
  });

  migrations.forEach((migration, i) => {
    if (migration?.deleted_classes === undefined) return;
    if (!isApprovedDeletion(migration)) {
      problems.push(
        `${where} migration ${JSON.stringify(migration?.tag)} carries deleted_classes ` +
          `${JSON.stringify(migration?.deleted_classes)} — the only approved deletion is ` +
          `${JSON.stringify(APPROVED_DELETION)}; deleting any other Durable Object data needs an explicit, reviewed change.`,
      );
    } else if (i !== HISTORY.length) {
      problems.push(`${where} the ${APPROVED_DELETION.tag} deletion must come right after v6.`);
    }
  });

  if (!migrations.some(isApprovedDeletion)) {
    problems.push(
      `${where} must include migration ${JSON.stringify(APPROVED_DELETION)} so the retired classes stop being exported with data behind them.`,
    );
  }

  const deleted = new Set(APPROVED_DELETION.deleted_classes);
  for (const binding of envCfg?.durable_objects?.bindings ?? []) {
    if (deleted.has(binding?.class_name)) {
      problems.push(`${where} still binds ${binding.name} to the deleted class ${binding.class_name}.`);
    }
  }
  return problems;
}
