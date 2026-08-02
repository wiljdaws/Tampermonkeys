import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyMigration,
  parseApplyArguments,
  runMigrationCommand,
  selectApprovedOperations,
} from "../scripts/apply-migrations.mjs";
import {
  documentSha256,
  PLAN_SCHEMA_VERSION,
} from "../scripts/plan-migrations.mjs";

function planWith(operations, overrides = {}) {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    release: "ATLAS 16.0",
    mode: "dry-run",
    containsProductionWrites: false,
    operations,
    unresolvedConflicts: [],
    blockers: [],
    ...overrides,
  };
}

function setOperation(id, documentPath, document, overrides = {}) {
  return {
    id,
    action: "set",
    path: documentPath,
    document,
    precondition: { exists: false },
    destructive: false,
    ...overrides,
  };
}

function deleteOperation(id, documentPath, document, overrides = {}) {
  return {
    id,
    action: "delete",
    path: documentPath,
    precondition: {
      exists: true,
      sha256: documentSha256(document),
    },
    destructive: true,
    ...overrides,
  };
}

async function writePlanBundle(directory, plan, {
  project = "sample-project",
  approvedOperationIds = [],
  conflictResolutions = [],
} = {}) {
  const planPath = path.join(directory, "plan.json");
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  const planSha256 = createHash("sha256").update(planText).digest("hex");
  const approvalsPath = path.join(directory, "approvals.json");
  await writeFile(planPath, planText);
  await writeFile(
    approvalsPath,
    `${JSON.stringify({
      schemaVersion: 1,
      project,
      planSha256,
      approvedOperationIds,
      conflictResolutions,
    }, null, 2)}\n`,
  );
  return { planPath, approvalsPath, planSha256 };
}

function productionArgs(bundle, overrides = {}) {
  const values = {
    project: "sample-project",
    confirmProject: "sample-project",
    hash: bundle.planSha256,
    approvals: bundle.approvalsPath,
    ...overrides,
  };
  return [
    "--plan",
    bundle.planPath,
    "--apply",
    "--project",
    values.project,
    "--confirm-project",
    values.confirmProject,
    "--approved-plan-sha256",
    values.hash,
    "--approvals",
    values.approvals,
  ];
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function createFirestoreMock() {
  const documents = new Map();
  const calls = [];
  let updateCounter = 0;

  function documentName(documentPath) {
    return `projects/sample-project/databases/(default)/documents/${documentPath}`;
  }

  const fetchImpl = async (urlValue, options) => {
    const url = String(urlValue);
    calls.push({ url, method: options.method });
    if (options.method === "GET") {
      const documentPath = decodeURIComponent(
        url.slice(url.indexOf("/documents/") + "/documents/".length),
      );
      const document = documents.get(documentPath);
      return document
        ? jsonResponse(200, document)
        : jsonResponse(404, {});
    }
    const body = JSON.parse(options.body);
    for (const write of body.writes) {
      if (write.update) {
        const documentPath = write.update.name.split("/documents/")[1];
        updateCounter += 1;
        documents.set(documentPath, {
          name: documentName(documentPath),
          fields: write.update.fields,
          createTime: "2026-08-02T00:00:00.000Z",
          updateTime: `2026-08-02T00:00:${String(updateCounter)
            .padStart(2, "0")}.000Z`,
        });
      } else if (write.delete) {
        documents.delete(write.delete.split("/documents/")[1]);
      }
    }
    return jsonResponse(200, {
      writeResults: body.writes.map(() => ({})),
    });
  };

  return { calls, documents, fetchImpl };
}

test("apply arguments default to help and dry run", () => {
  assert.deepEqual(parseApplyArguments([]), {
    help: true,
    apply: false,
  });
  assert.deepEqual(
    parseApplyArguments(["--plan", "plan.json"]),
    {
      help: false,
      apply: false,
      plan: "plan.json",
      project: "",
      confirmProject: "",
      approvedPlanSha256: "",
      approvals: "",
      batchSize: 20,
    },
  );
});

test("dry run loads only local files and reports blockers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-apply-"));
  try {
    const plan = planWith([], {
      unresolvedConflicts: [{
        id: "conflict-one",
        candidateIds: ["a", "b"],
      }],
    });
    const bundle = await writePlanBundle(directory, plan);
    let tokenCalls = 0;
    let fetchCalls = 0;
    const result = await runMigrationCommand(
      ["--plan", bundle.planPath],
      {
        getAccessToken: async () => {
          tokenCalls += 1;
          return "must-not-run";
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("must not run");
        },
      },
    );
    assert.equal(result.apply, false);
    assert.equal(result.ready, false);
    assert.match(result.blockedReason, /Unresolved conflicts/);
    assert.equal(tokenCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no credential or network call occurs until every gate passes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-gates-"));
  try {
    const operation = deleteOperation(
      "delete-one",
      "leaderboard/legacy",
      { sourceUserId: "player-a", playlist: "1v1" },
    );
    const bundle = await writePlanBundle(
      directory,
      planWith([operation]),
      { approvedOperationIds: [] },
    );
    const badApprovalsPath = path.join(directory, "wrong-approvals.json");
    await writeFile(badApprovalsPath, `${JSON.stringify({
      project: "other-project",
      planSha256: bundle.planSha256,
      approvedOperationIds: [operation.id],
    })}\n`);
    const cases = [
      ["--plan", bundle.planPath, "--apply"],
      productionArgs(bundle, { confirmProject: "other-project" }),
      productionArgs(bundle, { hash: "0".repeat(64) }),
      productionArgs(bundle, { approvals: badApprovalsPath }),
      productionArgs(bundle),
    ];

    for (const args of cases) {
      let tokenCalls = 0;
      let fetchCalls = 0;
      await assert.rejects(
        runMigrationCommand(args, {
          getAccessToken: async () => {
            tokenCalls += 1;
            return "secret-token";
          },
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not run");
          },
        }),
      );
      assert.equal(tokenCalls, 0);
      assert.equal(fetchCalls, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual clan conflicts cannot be approved into an automatic delete", () => {
  const conflict = {
    id: "clan-conflict",
    candidateIds: ["clan-old", "clan-new"],
    manualOnly: true,
  };
  assert.throws(
    () => selectApprovedOperations(
      planWith([], { unresolvedConflicts: [conflict] }),
      {
        conflictResolutions: [{
          conflictId: conflict.id,
          selectedId: "clan-old",
        }],
      },
    ),
    /reviewed source-data decision/,
  );
});

test("conflicts and blockers stop before credentials or network", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-blocked-"));
  try {
    const blockedPlans = [
      planWith([], {
        unresolvedConflicts: [{
          id: "leaderboard-conflict",
          candidateIds: ["row-a", "row-b"],
        }],
      }),
      planWith([], {
        blockers: [{
          type: "missing-device",
          clanId: "clan-a",
          userId: "player-a",
        }],
      }),
    ];
    for (let index = 0; index < blockedPlans.length; index += 1) {
      const child = path.join(directory, String(index));
      await mkdir(child, { recursive: true });
      const bundle = await writePlanBundle(child, blockedPlans[index]);
      let tokenCalls = 0;
      let fetchCalls = 0;
      await assert.rejects(
        runMigrationCommand(productionArgs(bundle), {
          getAccessToken: async () => {
            tokenCalls += 1;
            return "must-not-run";
          },
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("must not run");
          },
        }),
      );
      assert.equal(tokenCalls, 0);
      assert.equal(fetchCalls, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approved plan applies, verifies, checkpoints, and resumes idempotently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-run-"));
  const operation = setOperation(
    "set-directory",
    "clans_directory/clan-a",
    {
      clanId: "clan-a",
      name: "Clan A",
      tag: "AAA",
      leaderId: "player-a",
      memberCount: 1,
      memberIds: ["player-a"],
      deviceIds: ["device-a"],
    },
  );
  const bundle = await writePlanBundle(
    directory,
    planWith([operation]),
  );
  const mock = createFirestoreMock();
  let tokenCalls = 0;
  let statePath = "";
  try {
    const first = await runMigrationCommand(
      productionArgs(bundle),
      {
        getAccessToken: async () => {
          tokenCalls += 1;
          return "secret-token-never-printed";
        },
        fetchImpl: mock.fetchImpl,
      },
    );
    statePath = first.statePath;
    assert.equal(first.applied, 1);
    assert.equal(first.verified, 1);
    assert.equal(tokenCalls, 1);
    assert.equal(
      mock.calls.filter(call => call.method === "POST").length,
      1,
    );
    assert.doesNotMatch(JSON.stringify(first), /secret-token-never-printed/);

    const callsBeforeResume = mock.calls.length;
    const second = await runMigrationCommand(
      productionArgs(bundle),
      {
        getAccessToken: async () => {
          tokenCalls += 1;
          return "secret-token-never-printed";
        },
        fetchImpl: mock.fetchImpl,
      },
    );
    assert.equal(second.applied, 0);
    assert.equal(second.verified, 1);
    assert.equal(second.networkUsed, false);
    assert.equal(tokenCalls, 1);
    assert.equal(mock.calls.length, callsBeforeResume);
  } finally {
    if (statePath) await rm(statePath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch checkpoints resume after a later batch fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-resume-"));
  const statePath = path.join(directory, "state.json");
  const operations = [
    setOperation("first", "clans_directory/first", { value: 1 }),
    setOperation("second", "clans_directory/second", { value: 2 }),
  ];
  const mock = createFirestoreMock();
  let postCalls = 0;
  const flakyFetch = async (url, options) => {
    if (options.method === "POST") {
      postCalls += 1;
      if (postCalls === 2) {
        return jsonResponse(500, {
          error: { message: "simulated failure" },
        });
      }
    }
    return mock.fetchImpl(url, options);
  };

  try {
    await assert.rejects(
      applyMigration({
        project: "sample-project",
        planHash: "a".repeat(64),
        operations,
        batchSize: 1,
        statePath,
        fetchImpl: flakyFetch,
        getAccessToken: async () => "secret-token",
      }),
      /simulated failure/,
    );
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(saved.completedOperationIds, ["first"]);

    const resumed = await applyMigration({
      project: "sample-project",
      planHash: "a".repeat(64),
      operations,
      batchSize: 1,
      statePath,
      fetchImpl: mock.fetchImpl,
      getAccessToken: async () => "secret-token",
    });
    assert.equal(resumed.applied, 1);
    assert.equal(resumed.verified, 2);
    assert.equal(mock.documents.has("clans_directory/first"), true);
    assert.equal(mock.documents.has("clans_directory/second"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
