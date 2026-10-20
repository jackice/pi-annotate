import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { startAnnotationServer } from "../server.ts";

async function setup(t: TestContext) {
  const activeTimers = new Set<ReturnType<typeof setInterval>>();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args);
    activeTimers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => {
    activeTimers.delete(timer);
    realClearInterval(timer);
  });
  const server = await startAnnotationServer({
    markdown: "# test",
    htmlContent: "__ANNOTATE_DATA__",
    mode: "annotate",
  });
  t.after(() => {
    server.stop();
    // 失败测试也必须清理真实定时器，避免测试进程等待空闲超时
    for (const timer of activeTimers) realClearInterval(timer);
  });
  assert.equal(activeTimers.size, 1);
  return { server, activeTimers };
}

test("停止服务器立即结算 exit 决策并清理空闲定时器", async (t) => {
  const { server, activeTimers } = await setup(t);
  let decision: unknown;
  void server.waitForDecision().then((result) => { decision = result; });
  server.stop();
  await Promise.resolve();
  assert.deepEqual(decision, { action: "exit" });
  assert.equal(activeTimers.size, 0);
});

test("重复停止与晚到的决策不改变首次取消结果", async (t) => {
  const { server, activeTimers } = await setup(t);
  server.stop();
  server.stop();
  server.resolveDecision({ action: "approve" });
  let decision: unknown;
  void server.waitForDecision().then((result) => { decision = result; });
  await Promise.resolve();
  assert.deepEqual(decision, { action: "exit" });
  assert.equal(activeTimers.size, 0);
});

for (const action of ["approve", "feedback", "exit"] as const) {
  test(`正常 ${action} 决策立即清理定时器，stop 不覆盖结果`, async (t) => {
    const { server, activeTimers } = await setup(t);
    const decision = { action, feedback: "test" };
    server.resolveDecision(decision);
    assert.deepEqual(await server.waitForDecision(), decision);
    assert.equal(activeTimers.size, 0);
    server.stop();
    server.stop();
    assert.deepEqual(await server.waitForDecision(), decision);
  });
}
