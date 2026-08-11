// Publish-pipeline read counter. Every publish run writes an increment
// to read_stats_total/pipeline_YYYY-MM-DD so the admin dashboard can
// see how many Firestore reads the cron actually costs each day. Uses
// Firestore REST commit with FieldTransform.INCREMENT so we don't have
// to fetch the doc to update it. One write per publish run.

export function documentsBase(project) {
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Bumps the daily pipeline counter by `reads` and increments the run count
// by 1. Errors are non-fatal so a bad counter write doesn't fail publish.
export async function incrementPipelineReads({
  fetchImpl = fetch,
  token,
  project,
  label,
  reads,
} = {}) {
  if (!Number.isFinite(reads) || reads < 0) return;
  const date = todayIso();
  const docPath = `read_stats_total/pipeline_${date}`;
  const url = `${documentsBase(project)}:commit`;
  const body = {
    writes: [
      {
        update: {
          name: `projects/${project}/databases/(default)/documents/${docPath}`,
          fields: {
            date: { stringValue: date },
            source: { stringValue: "pipeline" },
            lastUpdatedAt: { timestampValue: new Date().toISOString() },
          },
        },
        updateMask: { fieldPaths: ["date", "source", "lastUpdatedAt"] },
        updateTransforms: [
          { fieldPath: `perLabel.${label}`, increment: { integerValue: String(reads) } },
          { fieldPath: "total", increment: { integerValue: String(reads) } },
          { fieldPath: "runs", increment: { integerValue: "1" } },
        ],
      },
    ],
  };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Goog-User-Project": project,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`[pipeline-counter] increment failed (${response.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[pipeline-counter] increment threw: ${err?.message || err}`);
  }
}
