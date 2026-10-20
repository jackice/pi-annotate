import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAutoAnnotate, type AutoAnnotateCandidate } from "../auto-annotate.ts";

const flushQueue = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-annotate-queue-"));
  const path = join(cwd, "docs/superpowers/specs/a.md");
  mkdirSync(join(cwd, "docs/superpowers/specs"), { recursive: true });
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi/annotate.json"), JSON.stringify({
    autoOpen: "write",
    include: ["docs/superpowers/**/*.md"],
    onWindowClose: "mute",
  }));
  const previousMode = process.env.PI_ANNOTATE_AUTO;
  process.env.PI_ANNOTATE_AUTO = "write";

  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const notices: string[] = [];
  const ctx = {
    cwd,
    ui: { notify: (_message: string, level: string) => notices.push(level) },
  } as unknown as ExtensionContext;
  const opened: Array<{
    candidate: AutoAnnotateCandidate;
    decision: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  registerAutoAnnotate(pi, async (_ctx, candidate) => {
    const decision = Promise.withResolvers<void>();
    opened.push({ candidate, decision });
    await decision.promise;
  });
  const emit = (event: string, data: unknown = {}) => handlers.get(event)!(data, ctx);
  let id = 0;
  async function write(markdown: string, isError = false) {
    const toolCallId = `write-${++id}`;
    emit("tool_call", { toolName: "write", toolCallId, input: { path } });
    if (!isError) writeFileSync(path, markdown);
    emit("tool_result", { toolName: "write", toolCallId, isError });
    assert.equal(emit("agent_settled"), undefined);
    await flushQueue();
  }
  emit("session_start");
  t.after(async () => {
    emit("session_shutdown");
    for (const entry of opened) entry.decision.resolve();
    await flushQueue();
    if (previousMode === undefined) delete process.env.PI_ANNOTATE_AUTO;
    else process.env.PI_ANNOTATE_AUTO = previousMode;
    rmSync(cwd, { recursive: true, force: true });
  });
  return { write, opened, notices };
}

test("跨 run 排队的相同内容在首个窗口正常结束后不重开", async (t) => {
  const { write, opened } = setup(t);
  await write("same");
  await write("same");
  assert.equal(opened.length, 1);
  opened[0].decision.resolve();
  await flushQueue();
  assert.equal(opened.length, 1);
});

for (const nextMarkdown of ["same", "changed"]) {
  test(`关窗静音后不打开已排队的 ${nextMarkdown} 内容`, async (t) => {
    const { write, opened } = setup(t);
    await write("same");
    await write(nextMarkdown);
    assert.equal(opened.length, 1);
    opened[0].candidate.onClosedWithoutFeedback();
    opened[0].decision.resolve();
    await flushQueue();
    assert.equal(opened.length, 1);
  });
}

test("首个窗口打开失败后，相同内容的排队候选仍可重试", async (t) => {
  t.mock.method(console, "error", () => {});
  const { write, opened, notices } = setup(t);
  await write("same");
  await write("same");
  opened[0].decision.reject(Object.assign(new Error("打开失败"), { code: "EOPEN" }));
  await flushQueue();
  assert.equal(opened.length, 2);
  assert.deepEqual(notices, ["error"]);
  opened[1].decision.resolve();
  await flushQueue();
  await write("same");
  assert.equal(opened.length, 2);
});

test("未静音且内容改变时，排队候选仍正常打开", async (t) => {
  const { write, opened } = setup(t);
  await write("first");
  await write("second");
  opened[0].decision.resolve();
  await flushQueue();
  assert.equal(opened.length, 2);
  assert.equal(opened[1].candidate.markdown, "second");
});

test("失败的工具结果不触发批注", async (t) => {
  const { write, opened } = setup(t);
  await write("not written", true);
  assert.equal(opened.length, 0);
});
