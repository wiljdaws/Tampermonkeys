import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  decodeFirestoreDocument,
} from "./snapshot-production.mjs";
import {
  documentSha256,
  PLAN_SCHEMA_VERSION,
} from "./plan-migrations.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(scriptDirectory, "..");
const stateDirectory = path.join(workspaceDirectory, ".migration-state");
const ALLOWED_COLLECTIONS = new Set([
  "clans",
  "clans_directory",
  "clan_name_keys",
  "clan_tag_keys",
  "clan_memberships",
  "clan_devices",
  "leaderboard",
]);

export const HELP = `Validate or apply an approved ATLAS 16.0 migration plan.

Dry run:
  npm run apply:migrations -- --plan <plan.json>

Production apply:
  npm run apply:migrations -- \\
    --plan <plan.json> \\
    --apply \\
    --project <project-id> \\
    --confirm-project <same-project-id> \\
    --approved-plan-sha256 <exact-plan-sha256> \\
    --approvals <approvals.json>

The default is local validation. No credential or network call happens unless
every production gate passes. Progress is saved under .migration-state/.
`;

function argumentValue(args, index, key) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${key} requires a value`);
  }
  return value;
}

export function parseApplyArguments(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    return { help: true, apply: false };
  }

  const options = {
    help: false,
    apply: false,
    plan: "",
    project: "",
    confirmProject: "",
    approvedPlanSha256: "",
    approvals: "",
    batchSize: 20,
  };
  const assigned = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (options.apply) throw new Error("--apply may only be provided once");
      options.apply = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const key = equals >= 0 ? argument.slice(0, equals) : argument;
    if (![
      "--plan",
      "--project",
      "--confirm-project",
      "--approved-plan-sha256",
      "--approvals",
      "--batch-size",
    ].includes(key)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (assigned.has(key)) {
      throw new Error(`${key} may only be provided once`);
    }
    assigned.add(key);
    const value = equals >= 0
      ? argument.slice(equals + 1)
      : argumentValue(args, index, key);
    if (equals < 0) index += 1;
    if (key === "--plan") options.plan = value;
    if (key === "--project") options.project = value;
    if (key === "--confirm-project") options.confirmProject = value;
    if (key === "--approved-plan-sha256") {
      options.approvedPlanSha256 = value.toLowerCase();
    }
    if (key === "--approvals") options.approvals = value;
    if (key === "--batch-size") {
      options.batchSize = Number(value);
    }
  }

  if (!options.plan) throw new Error("--plan is required");
  if (!Number.isInteger(options.batchSize)
      || options.batchSize < 1
      || options.batchSize > 20) {
    throw new Error("--batch-size must be an integer from 1 to 20");
  }
  return options;
}

function validateProjectId(project) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error("Project ID has an invalid format");
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function approvalMap(approvals) {
  return new Map(
    (approvals.conflictResolutions || []).map(resolution => [
      resolution.conflictId,
      resolution.selectedId,
    ]),
  );
}

function validateOperation(operation) {
  if (!operation?.id || !["set", "delete"].includes(operation.action)) {
    throw new Error("Plan contains an invalid operation");
  }
  const segments = String(operation.path || "").split("/");
  if (segments.length !== 2 || !ALLOWED_COLLECTIONS.has(segments[0])) {
    throw new Error(`Operation path is not allowed: ${operation.path}`);
  }
  if (!operation.precondition
      || typeof operation.precondition.exists !== "boolean") {
    throw new Error(`Operation ${operation.id} has no expected precondition`);
  }
  if (operation.precondition.exists
      && !/^[a-f0-9]{64}$/.test(operation.precondition.sha256 || "")) {
    throw new Error(`Operation ${operation.id} has no expected document hash`);
  }
  if (operation.action === "set" && !operation.document) {
    throw new Error(`Set operation ${operation.id} has no document`);
  }
}

export function selectApprovedOperations(plan, approvals = null) {
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`Unsupported plan schema: ${plan.schemaVersion}`);
  }
  if (!Array.isArray(plan.operations)) {
    throw new Error("Plan operations are missing");
  }
  for (const operation of plan.operations) validateOperation(operation);

  const resolutions = approvalMap(approvals || {});
  const unresolved = [];
  for (const conflict of plan.unresolvedConflicts || []) {
    const selectedId = resolutions.get(conflict.id);
    if (!selectedId) {
      unresolved.push(conflict.id);
      continue;
    }
    if (conflict.manualOnly) {
      unresolved.push(
        `${conflict.id} requires a reviewed source-data decision and a new plan`,
      );
      continue;
    }
    if (!(conflict.candidateIds || []).includes(selectedId)) {
      unresolved.push(`${conflict.id} has an invalid selectedId`);
    }
  }
  if (unresolved.length) {
    throw new Error(`Unresolved conflicts: ${unresolved.join(", ")}`);
  }
  if ((plan.blockers || []).length) {
    throw new Error(
      `Migration blockers remain: ${plan.blockers.length}`,
    );
  }

  const selected = plan.operations.filter(operation => {
    if (!operation.conditional) return true;
    return resolutions.get(operation.conditional.conflictId)
      === operation.conditional.selectedId;
  });
  const paths = new Set();
  for (const operation of selected) {
    if (paths.has(operation.path)) {
      throw new Error(`Selected operations collide at ${operation.path}`);
    }
    paths.add(operation.path);
  }
  return selected;
}

function validateProductionGates(options, planHash, approvals) {
  if (!options.apply) return;
  if (!options.project
      || !options.confirmProject
      || !options.approvedPlanSha256
      || !options.approvals) {
    throw new Error(
      "Production apply requires --project, --confirm-project, "
      + "--approved-plan-sha256, and --approvals",
    );
  }
  validateProjectId(options.project);
  if (options.project !== options.confirmProject) {
    throw new Error("--project and --confirm-project must match exactly");
  }
  if (!/^[a-f0-9]{64}$/.test(options.approvedPlanSha256)) {
    throw new Error("--approved-plan-sha256 must be an exact SHA-256");
  }
  if (options.approvedPlanSha256 !== planHash) {
    throw new Error("Approved plan SHA-256 does not match the plan file");
  }
  if (approvals.planSha256 !== planHash) {
    throw new Error("Approvals file does not match the plan SHA-256");
  }
  if (approvals.project !== options.project) {
    throw new Error("Approvals file does not match the exact project");
  }
}

function validateDestructiveApprovals(operations, approvals) {
  const approved = new Set(approvals?.approvedOperationIds || []);
  const missing = operations
    .filter(operation => operation.destructive)
    .filter(operation => !approved.has(operation.id))
    .map(operation => operation.id);
  if (missing.length) {
    throw new Error(
      `Destructive operations need explicit approval: ${missing.join(", ")}`,
    );
  }
}

async function loadInputs(options) {
  const planPath = path.resolve(process.cwd(), options.plan);
  const planText = await readFile(planPath, "utf8");
  const planHash = sha256(planText);
  const plan = JSON.parse(planText);
  let approvals = null;
  if (options.approvals) {
    const approvalsPath = path.resolve(process.cwd(), options.approvals);
    approvals = JSON.parse(await readFile(approvalsPath, "utf8"));
  }
  return { planPath, planText, planHash, plan, approvals };
}

export async function prepareMigration(options) {
  const inputs = await loadInputs(options);
  validateProductionGates(options, inputs.planHash, inputs.approvals || {});
  const operations = options.apply
    ? selectApprovedOperations(inputs.plan, inputs.approvals)
    : inputs.plan.operations;
  if (options.apply) {
    validateDestructiveApprovals(operations, inputs.approvals);
  }
  return {
    ...inputs,
    operations,
    statePath: path.join(stateDirectory, `${inputs.planHash}.json`),
  };
}

export async function getGcloudAccessToken() {
  const { stdout } = await execFileAsync(
    "gcloud",
    ["auth", "print-access-token"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDSDK_METRICS_ENVIRONMENT: "atlas-approved-migration",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const token = stdout.trim();
  if (!token) throw new Error("gcloud returned an empty access token");
  return token;
}

function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue),
      },
    };
  }
  if (value?.__firestoreType === "timestamp") {
    return { timestampValue: value.value };
  }
  if (value?.bytesValue) return { bytesValue: value.bytesValue };
  if (value?.referenceValue) {
    return { referenceValue: value.referenceValue };
  }
  if ("latitude" in (value || {}) && "longitude" in (value || {})) {
    return {
      geoPointValue: {
        latitude: value.latitude,
        longitude: value.longitude,
      },
    };
  }
  if (value && typeof value === "object") {
    return {
      mapValue: {
        fields: encodeFirestoreFields(value),
      },
    };
  }
  throw new Error(`Unsupported Firestore value: ${typeof value}`);
}

function encodeFirestoreFields(document) {
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => [
      key,
      encodeFirestoreValue(value),
    ]),
  );
}

function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
}

async function apiJson(fetchImpl, token, url, options) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    redirect: "error",
  });
  if (options.method === "GET" && response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Firestore request failed (${response.status}): ${message}`);
  }
  return body;
}

async function readDocument(fetchImpl, token, project, documentPath) {
  const body = await apiJson(
    fetchImpl,
    token,
    `${documentsBase(project)}/${documentPath}`,
    { method: "GET" },
  );
  return body ? decodeFirestoreDocument(body) : null;
}

function currentMatchesSet(current, operation) {
  return current
         && documentSha256(current.fields)
              === documentSha256(operation.document);
}

function verifyExpectedCurrent(current, operation) {
  const expected = operation.precondition;
  if (!expected.exists) {
    if (current) {
      throw new Error(
        `Precondition failed: ${operation.path} was expected to be missing`,
      );
    }
    return;
  }
  if (!current) {
    throw new Error(
      `Precondition failed: ${operation.path} was expected to exist`,
    );
  }
  if (documentSha256(current.fields) !== expected.sha256) {
    throw new Error(
      `Precondition failed: ${operation.path} document hash changed`,
    );
  }
  if (expected.updateTime && current.updateTime !== expected.updateTime) {
    throw new Error(
      `Precondition failed: ${operation.path} updateTime changed`,
    );
  }
}

function commitWrite(project, operation, current) {
  const name =
    `projects/${project}/databases/(default)/documents/${operation.path}`;
  const currentDocument = current?.updateTime
    ? { updateTime: current.updateTime }
    : { exists: false };
  if (operation.action === "delete") {
    return {
      delete: name,
      currentDocument,
    };
  }
  return {
    update: {
      name,
      fields: encodeFirestoreFields(operation.document),
    },
    currentDocument,
  };
}

async function prepareBatch({
  operations,
  fetchImpl,
  token,
  project,
}) {
  const writes = [];
  const completed = [];
  for (const operation of operations) {
    const current = await readDocument(
      fetchImpl,
      token,
      project,
      operation.path,
    );
    if (operation.action === "set" && currentMatchesSet(current, operation)) {
      completed.push(operation.id);
      continue;
    }
    if (operation.action === "delete" && !current) {
      completed.push(operation.id);
      continue;
    }
    verifyExpectedCurrent(current, operation);
    writes.push({
      operation,
      write: commitWrite(project, operation, current),
    });
  }
  return { writes, completed };
}

async function verifyBatch({
  operations,
  fetchImpl,
  token,
  project,
}) {
  for (const operation of operations) {
    const current = await readDocument(
      fetchImpl,
      token,
      project,
      operation.path,
    );
    if (operation.action === "delete" && current) {
      throw new Error(`Read-back verification failed: ${operation.path}`);
    }
    if (operation.action === "set"
        && !currentMatchesSet(current, operation)) {
      throw new Error(`Read-back verification failed: ${operation.path}`);
    }
  }
}

async function readState(statePath, project, planHash) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.project !== project || state.planSha256 !== planHash) {
      throw new Error("Migration state does not match this project and plan");
    }
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      project,
      planSha256: planHash,
      completedOperationIds: [],
      verifiedAt: null,
    };
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryPath, statePath);
}

export async function applyMigration({
  project,
  planHash,
  operations,
  batchSize,
  statePath,
  fetchImpl = globalThis.fetch,
  getAccessToken = getGcloudAccessToken,
  now = () => new Date(),
}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const state = await readState(statePath, project, planHash);
  const completed = new Set(state.completedOperationIds);
  const pending = operations.filter(operation => !completed.has(operation.id));
  if (!pending.length) {
    return {
      applied: 0,
      verified: operations.length,
      resumed: completed.size > 0,
      networkUsed: false,
      statePath,
    };
  }

  const token = await getAccessToken();
  let applied = 0;
  for (let index = 0; index < pending.length; index += batchSize) {
    const batch = pending.slice(index, index + batchSize);
    const prepared = await prepareBatch({
      operations: batch,
      fetchImpl,
      token,
      project,
    });
    if (prepared.writes.length) {
      await apiJson(
        fetchImpl,
        token,
        `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents:commit`,
        {
          method: "POST",
          body: JSON.stringify({
            writes: prepared.writes.map(item => item.write),
          }),
        },
      );
      applied += prepared.writes.length;
    }
    await verifyBatch({
      operations: batch,
      fetchImpl,
      token,
      project,
    });
    for (const operation of batch) completed.add(operation.id);
    state.completedOperationIds = [...completed];
    state.verifiedAt = now().toISOString();
    await writeState(statePath, state);
  }

  return {
    applied,
    verified: operations.length,
    resumed: state.completedOperationIds.length > pending.length,
    networkUsed: true,
    statePath,
  };
}

export async function runMigrationCommand(args, dependencies = {}) {
  const options = parseApplyArguments(args);
  if (options.help) return { help: true, networkUsed: false };

  const prepared = await prepareMigration(options);
  if (!options.apply) {
    let ready = true;
    let blockedReason = "";
    try {
      selectApprovedOperations(prepared.plan, prepared.approvals);
    } catch (error) {
      ready = false;
      blockedReason = error.message;
    }
    return {
      help: false,
      apply: false,
      networkUsed: false,
      planSha256: prepared.planHash,
      ready,
      blockedReason,
      operations: prepared.plan.operations.length,
      destructiveOperations: prepared.plan.operations.filter(operation =>
        operation.destructive).length,
    };
  }

  const result = await applyMigration({
    project: options.project,
    planHash: prepared.planHash,
    operations: prepared.operations,
    batchSize: options.batchSize,
    statePath: prepared.statePath,
    ...dependencies,
  });
  return {
    help: false,
    apply: true,
    planSha256: prepared.planHash,
    ...result,
  };
}

async function main() {
  const result = await runMigrationCommand(process.argv.slice(2));
  if (result.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!result.apply) {
    process.stdout.write(
      `Local plan SHA-256: ${result.planSha256}\n`
      + `Operations: ${result.operations}\n`
      + `Destructive operations: ${result.destructiveOperations}\n`
      + `${result.ready ? "Plan is ready for approval." : `Blocked: ${result.blockedReason}`}\n`,
    );
    return;
  }
  process.stdout.write(
    `Migration verified ${result.verified} operations; `
    + `applied ${result.applied}. State: ${result.statePath}\n`,
  );
}

const isEntryPoint =
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
