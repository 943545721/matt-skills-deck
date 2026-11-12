import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverMessage,
  registerDeliveryQueue,
  resetDeliveryQueueForTest,
} from "../server/delivery.ts";

/**
 * 往别的窗口递消息时的排队：目标窗口正在跑活就先攒着，等它这一轮结束再送。
 *
 * 这里不碰宿主：`agents.list()` 交回状态，`turn_ended` 由测试手动触发。
 */

function setup({ status = "idle", attentionReason = null, failList = false, retryMs = 10, sendError } = {}) {
  const handlers = new Map();
  const server = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  const state = {
    status,
    attentionReason,
    failList,
    sends: [],
    listCalls: 0,
    attempts: 0,
  };
  const paseo = {
    agents: {
      list: async () => {
        state.listCalls += 1;
        if (state.failList) throw new Error("daemon hiccup");
        return {
          entries: [{ agent: { id: "target", status: state.status, attentionReason: state.attentionReason } }],
        };
      },
      ref: (id) => ({
        send: async (text, options) => {
          state.attempts += 1;
          if (sendError?.(state.attempts, text)) throw new Error("send failed");
          state.sends.push({ id, text, options });
        },
      }),
    },
  };
  registerDeliveryQueue(server, { retryMs });
  return {
    state,
    paseo,
    turnEnded(agentId = "target") {
      return handlers.get("agent.turn_ended")({ agent: { id: agentId }, turnId: "t1", outcome: { kind: "completed" } });
    },
    archive(agentId = "target") {
      return handlers.get("agent.archived")({ agent: { id: agentId }, archivedAt: "2026-11-05T00:00:00Z" });
    },
  };
}

function clean(t) {
  t.after(() => resetDeliveryQueueForTest());
}

test("目标窗口空闲时立即送出", async (t) => {
  clean(t);
  const { state, paseo } = setup();
  await deliverMessage(paseo, "target", "【汇报】好了");
  assert.deepEqual(state.sends.map((one) => one.text), ["【汇报】好了"]);
  assert.equal(state.sends[0].options.activeTurnBehavior, "steer");
});

test("目标窗口在跑活时先排队，等回合结束再送", async (t) => {
  clean(t);
  const { state, paseo, turnEnded } = setup({ status: "running" });

  await deliverMessage(paseo, "target", "第一条");
  await deliverMessage(paseo, "target", "第二条");
  assert.deepEqual(state.sends, [], "忙的时候一条都不该塞进去");

  state.status = "idle";
  await turnEnded();
  assert.deepEqual(state.sends.map((one) => one.text), ["第一条", "第二条"], "按入队顺序补送");
});

test("回合结束时还在忙，就继续等下一轮", async (t) => {
  clean(t);
  const { state, paseo, turnEnded } = setup({ status: "running" });

  await deliverMessage(paseo, "target", "等一等");
  await turnEnded();
  assert.deepEqual(state.sends, [], "刚结束又开了新的一轮，仍然不塞");

  state.status = "idle";
  await turnEnded();
  assert.deepEqual(state.sends.map((one) => one.text), ["等一等"]);
});

test("卡在等人确认也算忙：硬塞会清掉人家的确认框", async (t) => {
  clean(t);
  // 状态是 idle、但 attentionReason 指向确认框：只靠状态会误判成空闲。
  const { state, paseo } = setup({ status: "idle", attentionReason: "permission" });
  await deliverMessage(paseo, "target", "先别打扰");
  assert.deepEqual(state.sends, []);
});

test("已经有队列时不插队：新消息排到队尾，按序补送", async (t) => {
  clean(t);
  const { state, paseo } = setup({ status: "running" });

  await deliverMessage(paseo, "target", "第一条");
  state.status = "idle";
  await deliverMessage(paseo, "target", "第二条");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(state.sends.map((one) => one.text), ["第一条", "第二条"]);
});

test("补送失败会重试，成功后不再重复", async (t) => {
  clean(t);
  const { state, paseo, turnEnded } = setup({
    status: "running",
    sendError: (attempt) => attempt === 1,
  });

  await deliverMessage(paseo, "target", "重试一次就好");
  state.status = "idle";
  await turnEnded();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(state.attempts, 2, "第一次失败、第二次成功");
  assert.deepEqual(state.sends.map((one) => one.text), ["重试一次就好"]);
});

test("排队期间那条消息不值得送了，就丢掉", async (t) => {
  clean(t);
  const { state, paseo, turnEnded } = setup({ status: "running" });
  let stillRelevant = true;

  await deliverMessage(paseo, "target", "【等你确认】……", { stillRelevant: () => stillRelevant });
  stillRelevant = false;
  state.status = "idle";
  await turnEnded();
  assert.deepEqual(state.sends, [], "请求已经被点掉，提醒不再补发");
});

test("会话归档后排着的消息一并丢掉", async (t) => {
  clean(t);
  const { state, paseo, turnEnded, archive } = setup({ status: "running" });

  await deliverMessage(paseo, "target", "没人看得到");
  archive();
  state.status = "idle";
  await turnEnded();
  assert.deepEqual(state.sends, []);
});

test("查不到目标窗口状态时直接送，不让消息无声卡住", async (t) => {
  clean(t);
  const { state, paseo } = setup({ failList: true });
  await deliverMessage(paseo, "target", "照样送");
  assert.deepEqual(state.sends.map((one) => one.text), ["照样送"]);
});

test("列表里没有这个窗口，按空闲处理", async (t) => {
  clean(t);
  const handlers = new Map();
  registerDeliveryQueue({ on: (name, handler) => handlers.set(name, handler) });
  const sends = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: () => ({ send: async (text) => sends.push(text) }),
    },
  };
  await deliverMessage(paseo, "someone-else", "发出去");
  assert.deepEqual(sends, ["发出去"]);
});

test("没注册队列时保持直接发送（单元测试/单独调用）", async (t) => {
  clean(t);
  const sends = [];
  const paseo = {
    agents: {
      ref: () => ({ send: async (text) => sends.push(text) }),
    },
  };
  await deliverMessage(paseo, "target", "直接送");
  assert.deepEqual(sends, ["直接送"]);
});

test("没注册队列时直接发送也要回调 onDelivered（交接 relay 靠它移出 pending）", async (t) => {
  clean(t);
  let delivered = 0;
  const paseo = {
    agents: {
      ref: () => ({ send: async () => undefined }),
    },
  };
  await deliverMessage(paseo, "target", "交接件", { onDelivered: () => { delivered += 1; } });
  assert.equal(delivered, 1);
});

test("没注册队列时发送失败回调 onDropped，并把错误抛回去", async (t) => {
  clean(t);
  const dropped = [];
  const paseo = {
    agents: {
      ref: () => ({ send: async () => { throw new Error("窗口没了"); } }),
    },
  };
  await assert.rejects(
    deliverMessage(paseo, "target", "交接件", { onDropped: (reason) => dropped.push(reason) }),
    /窗口没了/,
  );
  assert.deepEqual(dropped, ["窗口没了"]);
});

test("排队送出后回调 onDelivered；归档丢弃时回调 onDropped", async (t) => {
  clean(t);
  const { state, paseo, turnEnded, archive } = setup({ status: "running" });
  const events = [];
  await deliverMessage(paseo, "target", "排队件", {
    onDelivered: () => events.push("delivered"),
    onDropped: (reason) => events.push(`dropped:${reason}`),
  });
  state.status = "idle";
  await turnEnded();
  assert.deepEqual(events, ["delivered"]);

  const second = setup({ status: "running" });
  const secondEvents = [];
  await deliverMessage(second.paseo, "target", "没人收了", {
    onDropped: (reason) => secondEvents.push(reason),
  });
  second.archive();
  assert.deepEqual(secondEvents, ["closed"]);
});
