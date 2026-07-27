// Privacy regression gate for the Finch relay Worker.
//
// Relay request/response bodies are transient data-plane material. They may be
// buffered in memory long enough to forward, but they must not enter persistent
// Cloudflare telemetry, Durable Object state, or application logs. This gate is
// deliberately static and fail-closed: adding a new console site or widening a
// persisted relay-metadata type requires an explicit privacy review.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
// Shared with deploy-preflight so the two gates cannot drift, and so both
// agree with wrangler on where a line comment ends (CR as well as LF).
import { readJsonc } from "./jsonc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function fail(message) {
  throw new Error(`privacy invariant failed: ${message}`);
}

function assertNoExportedTelemetry(label, cfg) {
  if (cfg.logpush !== false) {
    fail(`${label}.logpush must be explicitly false`);
  }
  if (cfg.observability?.enabled !== false) {
    fail(`${label}.observability.enabled must be false`);
  }
}

/** Verify that production-shaped environments cannot persist automatic Worker
 * invocation telemetry. Dev may retain reviewed console errors, but never
 * automatic invocation logs or traces. */
export function assertPrivacyConfig(cfg) {
  assertNoExportedTelemetry("top-level", cfg);
  for (const name of ["staging", "production"]) {
    const env = cfg.env?.[name];
    if (!env) fail(`missing env.${name}`);
    assertNoExportedTelemetry(`env.${name}`, env);
    for (const banned of ["ALLOW_INSECURE_HTTP"]) {
      if (banned in (env.vars ?? {})) {
        fail(`env.${name}.vars.${banned} must not be shipped`);
      }
    }
  }

  const dev = cfg.env?.dev;
  if (!dev) fail("missing env.dev");
  if (dev.logpush !== false) fail("env.dev.logpush must be explicitly false");
  if (dev.observability?.enabled !== true) {
    fail("env.dev.observability must be explicitly enabled or disabled");
  }
  const logs = dev.observability.logs;
  if (
    logs?.enabled !== true ||
    logs?.invocation_logs !== false ||
    logs?.persist !== true
  ) {
    fail("env.dev may persist reviewed console logs only; invocation_logs must be false");
  }
  if (dev.observability.traces?.enabled !== false) {
    fail("env.dev observability traces must be disabled");
  }
}

function parseSource(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function interfaceFields(source, name) {
  for (const node of source.statements) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      return node.members.map((member) => {
        if (!member.name) fail(`${name} contains an unnamed member`);
        return member.name.getText(source).replace(/["']/g, "");
      });
    }
  }
  fail(`interface ${name} not found`);
}

function assertExactFields(source, name, expected) {
  const actual = interfaceFields(source, name).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${name} fields changed: expected [${wanted}], got [${actual}]`);
  }
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

const SAFE_CONSOLE_MESSAGES = new Set([
  "caller assertion JWKS unavailable",
  "caller assertion signing failed",
  // Renamed from "tenant directory reindex failed" when /api/tenant-create
  // stopped calling reindexTenant (the whole-keyspace scan) in favour of a
  // single upsertMembership. Reviewed: the arguments are { tenantId, error } —
  // a tenant id and a DO failure, no member email, no request body.
  "tenant directory index failed",
]);
const SENSITIVE_LOG_IDENTIFIERS = new Set([
  "body",
  "bodyBytes",
  "data",
  "frame",
  "headers",
  "payload",
  "raw",
  "req",
  "request",
  "res",
  "response",
]);

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name];
  const identifiers = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      identifiers.push(...bindingIdentifiers(element.name));
    }
  }
  return identifiers;
}

function nearestLexicalScope(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseBlock(current)) {
      return current;
    }
  }
  return undefined;
}

function sourceBindings(source) {
  const bindings = [];
  walk(source, (node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const identifier of bindingIdentifiers(node.variableDeclaration.name)) {
        bindings.push({
          name: identifier.text,
          declaration: identifier,
          scope: node.block,
          kind: "catch",
        });
      }
      return;
    }
    if (ts.isParameter(node) && node.parent) {
      for (const identifier of bindingIdentifiers(node.name)) {
        bindings.push({
          name: identifier.text,
          declaration: identifier,
          scope: node.parent,
          kind: "parameter",
          owner: node.parent,
        });
      }
      return;
    }
    if (ts.isVariableDeclaration(node) && !ts.isCatchClause(node.parent)) {
      const scope = nearestLexicalScope(node);
      if (!scope) return;
      for (const identifier of bindingIdentifiers(node.name)) {
        bindings.push({
          name: identifier.text,
          declaration: identifier,
          scope,
          kind: "variable",
          initializer: node.initializer,
        });
      }
    }
  });
  return bindings;
}

function resolveBinding(reference, bindings) {
  const position = reference.getStart();
  const matches = bindings.filter(
    (binding) =>
      binding.name === reference.text &&
      binding.declaration !== reference &&
      binding.declaration.getStart() < position &&
      binding.scope.getStart() <= position &&
      position < binding.scope.end,
  );
  matches.sort((left, right) => {
    const leftSpan = left.scope.end - left.scope.getStart();
    const rightSpan = right.scope.end - right.scope.getStart();
    return leftSpan - rightSpan || right.declaration.getStart() - left.declaration.getStart();
  });
  return matches[0];
}

function bindingWasReassigned(binding, before, bindings) {
  let reassigned = false;
  walk(binding.scope, (node) => {
    if (reassigned || node.getStart() >= before.getStart()) return;
    if (
      ts.isBinaryExpression(node) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      resolveBinding(node.left, bindings) === binding
    ) {
      reassigned = true;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      resolveBinding(node.operand, bindings) === binding
    ) {
      reassigned = true;
    }
  });
  return reassigned;
}

function isCatchCallback(owner) {
  const parent = owner.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(owner) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === "catch"
  );
}

function isReviewedErrorReference(reference, call, bindings) {
  const binding = resolveBinding(reference, bindings);
  if (!binding || bindingWasReassigned(binding, call, bindings)) return false;
  return binding.kind === "catch" || (binding.kind === "parameter" && isCatchCallback(binding.owner));
}

function originatesFromSensitiveValue(node, bindings, seen = new Set()) {
  let sensitive = false;
  walk(node, (part) => {
    if (sensitive) return;
    if (
      ts.isPropertyAccessExpression(part) &&
      SENSITIVE_LOG_IDENTIFIERS.has(part.name.text)
    ) {
      sensitive = true;
      return;
    }
    if (
      ts.isElementAccessExpression(part) &&
      ts.isStringLiteral(part.argumentExpression) &&
      SENSITIVE_LOG_IDENTIFIERS.has(part.argumentExpression.text)
    ) {
      sensitive = true;
      return;
    }
    if (!ts.isIdentifier(part)) return;
    if (
      (ts.isPropertyAccessExpression(part.parent) && part.parent.name === part) ||
      (ts.isPropertyAssignment(part.parent) && part.parent.name === part)
    ) {
      return;
    }
    if (SENSITIVE_LOG_IDENTIFIERS.has(part.text)) {
      sensitive = true;
      return;
    }
    const binding = resolveBinding(part, bindings);
    if (
      binding?.kind === "variable" &&
      binding.initializer &&
      !seen.has(binding) &&
      originatesFromSensitiveValue(binding.initializer, bindings, new Set([...seen, binding]))
    ) {
      sensitive = true;
    }
  });
  return sensitive;
}

function sanitizedErrorReference(node) {
  if (
    ts.isConditionalExpression(node) &&
    ts.isBinaryExpression(node.condition) &&
    node.condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    ts.isIdentifier(node.condition.left) &&
    node.condition.left.text === "error" &&
    ts.isIdentifier(node.condition.right) &&
    node.condition.right.text === "Error" &&
    ts.isPropertyAccessExpression(node.whenTrue) &&
    ts.isIdentifier(node.whenTrue.expression) &&
    node.whenTrue.expression.text === "error" &&
    node.whenTrue.name.text === "message" &&
    ts.isCallExpression(node.whenFalse) &&
    ts.isIdentifier(node.whenFalse.expression) &&
    node.whenFalse.expression.text === "String" &&
    node.whenFalse.arguments.length === 1 &&
    ts.isIdentifier(node.whenFalse.arguments[0]) &&
    node.whenFalse.arguments[0].text === "error"
  ) {
    return node.condition.left;
  }
  return undefined;
}

function directoryErrorMetadata(node) {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 2) return undefined;
  const fields = new Map();
  for (const property of node.properties) {
    if (!ts.isShorthandPropertyAssignment(property) || property.objectAssignmentInitializer) {
      return undefined;
    }
    fields.set(property.name.text, property.name);
  }
  if (fields.size !== 2 || !fields.has("tenantId") || !fields.has("error")) return undefined;
  return fields;
}

function isReviewedArguments(message, args, call, bindings) {
  if (args.length !== 2) return false;
  if (message === "tenant directory index failed") {
    const fields = directoryErrorMetadata(args[1]);
    if (!fields || !isReviewedErrorReference(fields.get("error"), call, bindings)) return false;
    const tenantBinding = resolveBinding(fields.get("tenantId"), bindings);
    return (
      tenantBinding?.kind === "variable" &&
      tenantBinding.initializer !== undefined &&
      !originatesFromSensitiveValue(tenantBinding.initializer, bindings)
    );
  }
  const error = sanitizedErrorReference(args[1]);
  return error !== undefined && isReviewedErrorReference(error, call, bindings);
}

function assertReviewedConsoleCalls(source) {
  const bindings = sourceBindings(source);
  walk(source, (node) => {
    // Only a direct, non-optional `console.error(...)` call is reviewable.
    // Bracket notation and aliases are rejected at the `console` reference
    // below so a newly named logger cannot bypass this gate.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      const first = node.arguments[0];
      if (
        node.questionDotToken ||
        node.expression.questionDotToken ||
        node.expression.name.text !== "error" ||
        !first ||
        !ts.isStringLiteral(first) ||
        !SAFE_CONSOLE_MESSAGES.has(first.text) ||
        !isReviewedArguments(first.text, node.arguments, node, bindings)
      ) {
        fail(`${source.fileName} contains an unreviewed console call`);
      }
    }

    if (ts.isIdentifier(node) && node.text === "console") {
      const parent = node.parent;
      const direct =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        !parent.questionDotToken &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        !parent.parent.questionDotToken;
      if (!direct) fail(`${source.fileName} contains an aliased or indirect console reference`);
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["globalThis", "self", "window"].includes(node.expression.text) &&
        node.name.text === "console") ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["globalThis", "self", "window"].includes(node.expression.text) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "console")
    ) {
      fail(`${source.fileName} contains an aliased or indirect console reference`);
    }
  });
}

/** Test seam for the static console guard. Keeping this parser in the real
 * checker lets the self-tests exercise the exact production AST rules. */
export function assertReviewedConsoleSource(text, fileName = "privacy-fixture.ts") {
  assertReviewedConsoleCalls(
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  );
}

function assertNoRelayStorage(source) {
  walk(source, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return;
    if (node.name.text !== "storage") return;
    fail(`${source.fileName} accesses Durable Object storage on the relay data plane`);
  });
}

function methodParameters(source, name) {
  let params;
  walk(source, (node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) {
      params = node.parameters.map((parameter) => parameter.name.getText(source));
    }
  });
  if (!params) fail(`method ${name} not found in ${source.fileName}`);
  return params;
}

/** Source-level guardrails complement runtime tests by failing on newly added
 * log sites, relay-plane storage, or widened persisted metadata schemas. */
export function assertPrivacySource() {
  const index = parseSource(join(root, "src", "index.ts"));
  const box = parseSource(join(root, "src", "box-do.ts"));
  const tenant = parseSource(join(root, "src", "tenant-do.ts"));
  const api = parseSource(join(root, "src", "api.ts"));
  const types = parseSource(join(root, "src", "types.ts"));

  for (const source of [index, box, tenant, api]) assertReviewedConsoleCalls(source);
  // Request and response payloads live only in index/BoxDO memory. Any storage
  // access added to either relay component requires a different design review.
  assertNoRelayStorage(index);
  assertNoRelayStorage(box);

  assertExactFields(box, "SockMeta", ["tenant", "service", "box"]);
  assertExactFields(types, "RecentCall", ["ts", "ago", "route", "caller", "status", "ms"]);
  assertExactFields(types, "LogEvent", ["ago", "ts", "cat", "actor", "action", "target", "ip", "result"]);

  const recordCall = methodParameters(tenant, "recordCall");
  const expected = ["service", "box", "status", "ms", "caller", "route"];
  if (JSON.stringify(recordCall) !== JSON.stringify(expected)) {
    fail(`TenantDO.recordCall must accept metadata only; got [${recordCall}]`);
  }
}

export function checkPrivacyInvariants() {
  assertPrivacyConfig(readJsonc(join(root, "wrangler.jsonc")));
  assertPrivacySource();
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    checkPrivacyInvariants();
    console.log("finch privacy invariants OK (telemetry off; relay state/logs metadata-only)");
  } catch (error) {
    console.error(`finch privacy invariants FAILED: ${error.message}`);
    process.exit(1);
  }
}
