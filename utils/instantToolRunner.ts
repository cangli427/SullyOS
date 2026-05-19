/**
 * instantToolRunner — Phase 2 Round 2 客户端 tool runner
 *
 * 消费 SW 写到 `pending_tool_calls` store 的 ToolRequestPush, 用 agenticTools 跑本地工具,
 * 把 OpenAI-shape tool result 拼好 POST /continue 让 worker 续跑下一轮 LLM. final push
 * 由 SW 像首轮一样写 inbox, ActiveMsgRuntime.flushInboxToChat 跑 applyAssistantPostProcessing.
 *
 * 触发时机:
 *   - ActiveMsgRuntime.init 启动时排空一次 (兜底冷启动 / swipe-kill 重启)
 *   - SW 收到 tool_request push + 当前 window visible 时 postMessage('instant-tool-request'),
 *     ActiveMsgRuntime 收到后立刻调用 runPendingToolCalls()
 *
 * 失败语义:
 *   - dispatch 抛错 (DB / 网络) → 这条 pending 已被 atomic claim 走, 重试需要用户重新触发推送
 *   - POST /continue 失败 → 同上; 留 console.error, 后续 phase 加 dead-letter
 *   - 走"先 ack 后处理"是为了不让重投 push 把 toolCalls 跑两遍 (LLM 费用 + UI 重复)
 */

import { ActiveMsgStore } from './activeMsgStore';
import { DB } from './db';
import { dispatchAgenticTool, type AgenticToolCtx } from './agenticTools';
import { loadInstantConfig, isInstantConfigReady, getOrCreateInstantSubscription } from './instantPushClient';
import type { APIConfig, RealtimeConfig, UserProfile, InstantPushPendingToolCall } from '../types';

/** 跑一轮 ToolRequest → POST /continue. 失败时返回 false (上层决定要不要 toast). */
async function runOnePendingToolCall(item: InstantPushPendingToolCall): Promise<boolean> {
  const session = await ActiveMsgStore.getOutboundSession(item.sessionId);
  if (!session) {
    console.warn('[instant-tool-runner] outbound session not found, skipping', item.sessionId);
    return false;
  }

  const characters = await DB.getAllCharacters();
  const char = characters.find((c) => c.id === item.charId);
  if (!char) {
    console.warn('[instant-tool-runner] character not found', item.charId);
    return false;
  }

  const userProfile: UserProfile =
    (await DB.getUserProfile()) ?? { name: 'User', avatar: '', bio: '' };
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // tool runner 用的 ctx 跟 applyAssistantPostProcessing 本地 fetch 路径用的是同一个形状.
  // xhsCaches 这里每次新建一个空 Map: 客户端 push 路径已经没法跨 round 共享 useRef 状态了
  // (没 React tree), XHS detail retry / share-by-idx 这种依赖跨 tool token cache 的高阶用法
  // Round 2 直接接受降级 — 大部分场景用不到.
  const xhsCaches = {
    xsecTokenCache: new Map<string, string>(),
    noteTitleCache: new Map<string, string>(),
    commentUserIdCache: new Map<string, string>(),
    commentAuthorNameCache: new Map<string, string>(),
    commentParentIdCache: new Map<string, string>(),
  };
  const ctx: AgenticToolCtx = {
    char,
    userProfile,
    realtimeConfig,
    xhsCaches,
    lastXhsNotesRef: { current: [] },
    onProgress: (_channel, text) => {
      console.log('[instant-tool-runner:progress]', text);
    },
  };

  // 1. 跑所有 tool, 串行 — agenticTools 内部多步 (XHS retry / DIARY fallback) 不能并发.
  const toolResults: Array<{ tool_call_id: string; role: 'tool'; content: string }> = [];
  for (const call of item.toolCalls) {
    let result: unknown;
    try {
      const args = JSON.parse(call.function.arguments || '{}');
      result = await dispatchAgenticTool(call.function.name, args, ctx);
    } catch (e) {
      console.error('[instant-tool-runner] tool failed', call.function.name, e);
      result = { ok: false, reason: 'tool_threw', message: (e as Error)?.message ?? String(e) };
    }
    toolResults.push({
      tool_call_id: call.id,
      role: 'tool',
      // OpenAI 兼容端点要求 tool result content 是字符串; agenticTools 返结构化 result, JSON 化.
      content: JSON.stringify(result),
    });
  }

  // 2. 拼下一轮 LLM 看到的 messages: outbound history + assistant tool_call message + tool results.
  //    这是 OpenAI tool-call 协议的标准形状; worker 拿到后会直接转发给 LLM.
  const assistantMsg = {
    role: 'assistant' as const,
    content: item.llmOutputText || '',
    tool_calls: item.toolCalls,
  };
  const nextMessages = [...session.messages, assistantMsg, ...toolResults];

  // 3. 找到 push subscription + worker 凭据.
  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    console.warn('[instant-tool-runner] instant config not ready, cannot continue');
    return false;
  }
  const { sub } = await getOrCreateInstantSubscription();
  if (!sub) {
    console.warn('[instant-tool-runner] no push subscription, cannot continue');
    return false;
  }

  // 4. POST /continue. body 形状 = /instant + sessionId + iteration. apiCredentials 从
  //    outbound_session 取 (sendInstantPush 时记下的, 跨 round 用同一组).
  const apiConfig = loadApiConfigFromLocalStorage();
  const url = `${cfg.workerUrl.replace(/\/+$/, '')}/continue`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.clientToken) headers['X-Client-Token'] = cfg.clientToken;

  // iteration: SW 在 savePendingToolCall 时持久化了上一轮 worker hook 看到的 iteration
  // (从 push.metadata.iteration 透传). /continue 必须严格递增, worker 端 fail-fast 400 守.
  const nextIteration = (item.iteration ?? 0) + 1;

  const body = JSON.stringify({
    sessionId: item.sessionId,
    iteration: nextIteration,
    messages: nextMessages,
    pushSubscription: sub,
    apiUrl: session.apiCredentials.baseUrl || apiConfig.baseUrl,
    apiKey: session.apiCredentials.apiKey || apiConfig.apiKey,
    primaryModel: session.apiCredentials.model || apiConfig.model,
    contactName: char.name,
    avatarUrl: char.avatar,
    charId: item.charId,
    metadata: { charId: item.charId, charName: char.name },
    temperature: 0.8,
  });

  try {
    const res = await fetch(url, { method: 'POST', headers, body, keepalive: body.length <= 60 * 1024 });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      console.error('[instant-tool-runner] /continue HTTP failed', res.status, text);
      return false;
    }
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (parsed && parsed.success === false) {
      console.error('[instant-tool-runner] /continue worker rejected', parsed.error);
      return false;
    }
    // status === 'loop_exceeded' 也是 HTTP 200 + success:true (见 amsg-instant 错误码表),
    // 我们不在这里弹错; SW 会单独收到 error push, ActiveMsgRuntime 处理.
    return true;
  } catch (e) {
    console.error('[instant-tool-runner] /continue fetch threw', e);
    return false;
  }
}

/** 排空 pending_tool_calls store; 调用前后都是原子, 失败的不重投 (见 module 顶 doc). */
export async function runPendingToolCalls(): Promise<{ processed: number; ok: number }> {
  const pending = await ActiveMsgStore.consumePendingToolCalls();
  let ok = 0;
  for (const item of pending) {
    const success = await runOnePendingToolCall(item);
    if (success) ok += 1;
  }
  if (pending.length > 0) {
    console.log(`[instant-tool-runner] processed ${pending.length} pending tool call(s), ${ok} ok`);
  }
  return { processed: pending.length, ok };
}

// ── private helpers ─────────────────────────────────────────────────────────

function loadApiConfigFromLocalStorage(): APIConfig {
  const fallback: APIConfig = { baseUrl: '', apiKey: '', model: '' };
  try {
    const raw = localStorage.getItem('os_api_config');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || '',
      apiKey: parsed.apiKey || '',
      model: parsed.model || '',
      ...parsed,
    };
  } catch {
    return fallback;
  }
}

function loadRealtimeConfigFromLocalStorage(): RealtimeConfig | undefined {
  try {
    const raw = localStorage.getItem('os_realtime_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    return undefined;
  }
}

