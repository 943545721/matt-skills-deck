import { useSettings } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  BUDGET,
  REFRESH_TIMING,
  createAttentionState,
  planAttention,
  planRefresh,
  reportAttention,
  type AttentionState,
  type RefreshDecision,
} from "../../../shared/refresh";
import { deckSettings } from "../../../shared/settings";

/**
 * 面板刷新钩子。
 *
 * 纯策略在 `shared/refresh.ts`；这里只做三件副作用：
 * - 把 AppState 的聚焦/失焦送进注意力模型，并在聚焦时每 20 秒发一次心跳；
 * - 把查询结果折算成「连续失败 / 上次成功」，喂给 `planRefresh`；
 * - 按裁决结果挂一个 `setTimeout`，到期 `refetch`。
 *
 * 不用 react-query 的 `refetchInterval`：裁决里的 0 表示「现在就该刷」，
 * 而 `refetchInterval: 0` 在 tanstack 里是「关闭」。自己挂定时器语义更清楚。
 */

/** 只依赖 react-query 返回值的这几个字段，避免把整个查询对象类型拖进来。 */
export interface HealthQuery {
  data?: unknown;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  refetch(): unknown;
}

export interface QueryHealth {
  failures: number;
  lastSuccessAt: number | null;
}

function resultFlag(data: unknown): "ok" | "fail" | null {
  if (typeof data !== "object" || data === null || !("ok" in data)) return null;
  const ok = (data as { ok?: unknown }).ok;
  if (ok === true) return "ok";
  if (ok === false) return "fail";
  return null;
}

/**
 * 把查询生命周期折算成退避要的两个数。
 *
 * 只有「新的结果 / 新的错误」才推进计数：同一份数据因为父组件重渲染而重算，
 * 不能当成又一次失败，否则面板会自己把自己退避到 5 分钟。
 */
export function useQueryHealth(query: HealthQuery): QueryHealth {
  const [health, setHealth] = useState<QueryHealth>({ failures: 0, lastSuccessAt: null });
  const seen = useRef({ dataAt: 0, errorAt: 0 });

  useEffect(() => {
    const dataAt = query.dataUpdatedAt || 0;
    const errorAt = query.errorUpdatedAt || 0;
    if (dataAt === seen.current.dataAt && errorAt === seen.current.errorAt) return;
    const freshData = dataAt !== seen.current.dataAt;
    seen.current = { dataAt, errorAt };
    const flag = resultFlag(query.data);
    if (freshData && flag === "ok") {
      setHealth({ failures: 0, lastSuccessAt: dataAt });
      return;
    }
    if ((freshData && flag === "fail") || errorAt !== 0) {
      setHealth((prev) => ({ ...prev, failures: Math.min(prev.failures + 1, 1_000) }));
    }
  }, [query.data, query.dataUpdatedAt, query.errorUpdatedAt]);

  return health;
}

export interface PanelRefreshInput {
  query: HealthQuery;
  /** 剩余额度比例；null = 未知。 */
  remaining: number | null;
  /** 本页是否启用自动刷新（没有工作区、或页签不轮询时传 false）。 */
  enabled?: boolean;
}

export interface PanelRefreshState {
  decision: RefreshDecision;
  failures: number;
  lastSuccessAt: number | null;
  /** 写操作成功后调用：下一次裁决会立刻刷新一次。 */
  markWrite(): void;
  /** 手动刷新（按钮用），不受策略暂停限制。 */
  refreshNow(): void;
}

export function usePanelRefresh({ query, remaining, enabled = true }: PanelRefreshInput): PanelRefreshState {
  const settings = useSettings(deckSettings);
  const refreshSeconds = settings.status === "ready" ? settings.values.refreshSeconds : 60;
  const health = useQueryHealth(query);
  const [attention, setAttention] = useState<AttentionState>(() => createAttentionState());
  const [lastWriteAt, setLastWriteAt] = useState<number | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    const apply = (active: boolean) => {
      focusedRef.current = active;
      setAttention((prev) =>
        reportAttention(prev, active ? "focus" : "window-blur", Date.now()),
      );
    };
    // 启动早期 AppState.currentState 可能是 null / "unknown"：按「在前台」处理，
    // 否则面板会一直停在 hidden，直到用户切一次前后台才恢复自动刷新。
    const initial = AppState.currentState;
    apply(initial === null || initial === undefined || initial === "unknown" || initial === "active");
    const subscription = AppState.addEventListener("change", (next) => apply(next === "active"));
    const heartbeat = setInterval(() => {
      // 心跳只在聚焦时发；失焦后由注意力模型在 30 秒保留期结束时收拢。
      if (focusedRef.current) {
        setAttention((prev) => reportAttention(prev, "heartbeat", Date.now()));
      }
    }, REFRESH_TIMING.heartbeatMs);
    return () => {
      subscription.remove();
      clearInterval(heartbeat);
    };
  }, []);

  const now = Date.now();
  const attentionPlan = planAttention(attention, now);
  const policy = planRefresh({
    visible: attentionPlan.active,
    focused: attentionPlan.reason === "active",
    lastSuccessAt: health.lastSuccessAt,
    failures: health.failures,
    remaining,
    reserveRatio: BUDGET.writeReserveShare,
    nowMs: now,
    lastWriteAt,
  });
  // 设置里关掉自动刷新时，策略仍然计算（写权限照旧），只是不挂定时器。
  const decision: RefreshDecision =
    refreshSeconds <= 0 && policy.delayMs >= 0
      ? { ...policy, delayMs: -1, reason: "disabled" }
      : policy;

  useEffect(() => {
    if (!enabled || decision.delayMs < 0) return;
    // 首次挂载时 react-query 自己会取一次；`initial` 再排一次就是同一份数据读两遍，
    // 白烧一次额度。等第一份结果（成功或失败）落地后，健康状态会推进到 probe/backoff。
    if (decision.reason === "initial" && query.dataUpdatedAt === 0 && query.errorUpdatedAt === 0) return;
    // delay 0 是「现在刷」，给 250ms 让同一轮渲染先落盘，避免请求风暴。
    const timer = setTimeout(() => {
      void query.refetch();
    }, Math.max(decision.delayMs, 250));
    return () => clearTimeout(timer);
  }, [
    enabled,
    decision.delayMs,
    decision.reason,
    query.dataUpdatedAt,
    query.errorUpdatedAt,
    query.refetch,
  ]);

  return {
    decision,
    failures: health.failures,
    lastSuccessAt: health.lastSuccessAt,
    markWrite: () => setLastWriteAt(Date.now()),
    refreshNow: () => {
      void query.refetch();
    },
  };
}
