const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createPendingCaptureQueue({ filePath }) {
  function read() {
    try {
      const records = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(records)
        ? records.filter((record) => record && typeof record.id === "string" && record.message)
        : [];
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      return [];
    }
  }

  function write(records) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(records), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows does not support POSIX file modes.
    }
  }

  return {
    read,
    enqueue(message) {
      const capture = { id: crypto.randomUUID(), message };
      const captures = read();
      captures.push(capture);
      write(captures);
      return capture;
    },
    acknowledge(ids) {
      const acknowledged = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
      if (acknowledged.size === 0) return read();
      const remaining = read().filter((capture) => !acknowledged.has(capture.id));
      write(remaining);
      return remaining;
    },
  };
}

module.exports = { createPendingCaptureQueue };
