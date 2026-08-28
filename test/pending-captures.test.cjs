const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { createPendingCaptureQueue } = require("../chrome-extension/native/pending-captures.cjs");

test("persists screenshot-bearing captures until Pi acknowledges recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-annotate-pending-test-"));
  const filePath = join(directory, "pending-captures.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const queue = createPendingCaptureQueue({ filePath });
  const capture = queue.enqueue({
    type: "ANNOTATIONS_COMPLETE",
    requestId: 17,
    result: {
      success: true,
      url: "https://example.test",
      elements: [],
      screenshot: "data:image/png;base64,c2NyZWVuc2hvdA==",
    },
  });

  const reopenedQueue = createPendingCaptureQueue({ filePath });
  assert.deepEqual(reopenedQueue.read(), [{
    id: capture.id,
    message: {
      type: "ANNOTATIONS_COMPLETE",
      requestId: 17,
      result: {
        success: true,
        url: "https://example.test",
        elements: [],
        screenshot: "data:image/png;base64,c2NyZWVuc2hvdA==",
      },
    },
  }]);

  reopenedQueue.acknowledge([capture.id]);
  assert.deepEqual(reopenedQueue.read(), []);
});
