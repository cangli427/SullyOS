/// <reference lib="WebWorker" />

import { installReiSW } from '@rei-standard/amsg-sw';

/**
 * SW_VERSION: 改 SW 实质行为时（push handler / message protocol / 通知策略 / IDB 升级）
 * 手工 bump。前端 BuildBadge 通过 GET_SW_VERSION postMessage 协议读取并显示，
 * 也作为 source-bytes-changed 的 cache buster 让浏览器 24h SW 缓存绕过去。
 *
 * 历史：
 *  - 1.0.0: 初版 ActiveMsg 2.0 push + keep-alive
 *  - 1.1.0: 加 BuildBadge SW 版本协议 + 文案通用化
 *  - 1.2.0: iOS 前台跳过 showNotification
 *  - 1.3.0: 测试推送 metadata.test 强制弹通知
 *  - 1.4.0: Phase 2 Round 1 — ActiveMsg IDB v1→v2 (加 outbound_sessions /
 *           pending_tool_calls / reasoning_buffer 三个 store), 上线后老 SW 不升级
 *           会因为 VersionError 丢推送, 必须 bump 触发字节比较 + 重装。
 *  - 1.5.0: Phase 2 Round 2 — push handler 按 messageKind 分轨
 *           (content / reasoning / tool_request / error), 处理 _blob envelope,
 *           tool_request 按 visibility 决定 postMessage 或 showNotification。
 *  - 1.5.1: saveContentToInbox 兼容 directive-only push (body 空但 metadata.directives
 *           非空, e.g. LLM 只输出 [[ACTION:POKE]] 时), 不再 early-return 漏掉副作用.
 *  - 1.5.2: saveContentToInbox gate 化简到只看 charId — directive-only / 空 payload
 *           都信任 worker 契约, 不在 SW 二次验证, 行为更可预测.
 *  - 1.6.0: amsg-instant 升 0.8.0-next.2, ReasoningPush 自动按字节切多 push.
 *           saveReasoningToBuffer 改累积式 (chunks[] 数组, read-modify-write),
 *           按 (messageIndex, chunkIndex) 保留每个分片, 主线程 claimReasoning
 *           取出时排序拼接. savePendingToolCall 之前清空同 sessionId 的 reasoning
 *           buffer — 镜像主应用 `data = newResponse` 的"只保留最后一轮 reasoning"
 *           行为, 避免 agentic loop 跨轮污染.
 *  - 1.7.0: content push 在没有可见 client 时补一条系统通知 (notifyClosedClientForContent).
 *           之前只有 tool_request 弹通知, content (含写日记的 directive 回复) 关浏览器 /
 *           后台冻结时零通知 — 用户不知道要回前台, inbox 不 flush, 客户端副作用 (写 Notion)
 *           永远不跑. 与 tool_request 同策略: 有可见 client 交给 in-app UI, 否则系统通知.
 *  - 1.8.0: 新增 emotion_update push 分轨 (saveEmotionUpdateToInbox). worker 端跑完副 API 情绪
 *           评估后把 buff 结果推回, 静默写 inbox (不弹通知/不计未读), 客户端 flush 时落 buff.
 */
const SW_VERSION = '1.8.1';

const PING_INTERVAL = 15_000;
const MAX_MANUAL_ALIVE_MS = 5 * 60_000;
const ACTIVE_MSG_DB_NAME = 'ActiveMsg';
// MUST be kept in sync with utils/activeMsgStore.ts:DB_VERSION. Phase 2 Round 1 bumped to 2 to add
// outbound_sessions / pending_tool_calls / reasoning_buffer stores. SW only reads/writes `inbox`,
// but if SW pins a lower version while main thread is on v2, SW's open() will throw VersionError
// and push messages will be silently dropped.
const ACTIVE_MSG_DB_VERSION = 2;
const ACTIVE_MSG_INBOX_STORE = 'inbox';
const ACTIVE_MSG_OUTBOUND_SESSIONS_STORE = 'outbound_sessions';
const ACTIVE_MSG_PENDING_TOOL_CALLS_STORE = 'pending_tool_calls';
const ACTIVE_MSG_REASONING_BUFFER_STORE = 'reasoning_buffer';

let pingTimer: number | null = null;
let manualKeepAliveCount = 0;
let manualKeepAliveStartedAt = 0;

const proactiveSchedules = new Map<string, { charId: string; intervalMs: number }>();
const proactiveTimers = new Map<string, number>();

const sw = self as unknown as ServiceWorkerGlobalScope;

installReiSW(sw, {
  defaultIcon: './icons/icon-192.png',
  defaultBadge: './icons/icon-192.png',
});

function hasActiveProactiveSchedules() {
  return proactiveTimers.size > 0;
}

function shouldKeepAlive() {
  return manualKeepAliveCount > 0 || hasActiveProactiveSchedules();
}

function stopPingLoop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function ensurePingLoop() {
  if (pingTimer) return;

  pingTimer = setInterval(() => {
    if (manualKeepAliveCount > 0 && Date.now() - manualKeepAliveStartedAt > MAX_MANUAL_ALIVE_MS) {
      manualKeepAliveCount = 0;
      manualKeepAliveStartedAt = 0;
    }

    if (!shouldKeepAlive()) {
      stopPingLoop();
      return;
    }

    sw.registration.active?.postMessage({ type: 'ping' });
  }, PING_INTERVAL) as unknown as number;
}

function refreshKeepAlive() {
  if (shouldKeepAlive()) ensurePingLoop();
  else stopPingLoop();
}

function startKeepAlive() {
  manualKeepAliveCount += 1;
  if (!manualKeepAliveStartedAt) manualKeepAliveStartedAt = Date.now();
  refreshKeepAlive();
}

function stopKeepAlive() {
  if (manualKeepAliveCount > 0) manualKeepAliveCount -= 1;
  if (manualKeepAliveCount === 0) manualKeepAliveStartedAt = 0;
  refreshKeepAlive();
}

async function notifyClients(data: Record<string, any>) {
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(data);
  }
}

function fireProactiveTrigger(charId: string) {
  void notifyClients({ type: 'proactive-trigger', charId });
}

function stopProactive(charId: string) {
  const timer = proactiveTimers.get(charId);
  if (timer) {
    clearInterval(timer);
    proactiveTimers.delete(charId);
  }
  proactiveSchedules.delete(charId);
}

function upsertProactive(config: { charId: string; intervalMs: number }) {
  const prev = proactiveSchedules.get(config.charId);
  const unchanged = prev && prev.intervalMs === config.intervalMs;
  if (unchanged && proactiveTimers.has(config.charId)) return;

  stopProactive(config.charId);
  proactiveSchedules.set(config.charId, config);

  const timer = setInterval(() => fireProactiveTrigger(config.charId), config.intervalMs) as unknown as number;
  proactiveTimers.set(config.charId, timer);
}

function syncProactive(configs: Array<{ charId: string; intervalMs: number }>) {
  const nextIds = new Set((configs || []).map((config) => config.charId));

  for (const charId of Array.from(proactiveSchedules.keys())) {
    if (!nextIds.has(charId)) stopProactive(charId);
  }

  for (const config of configs || []) {
    if (config && config.charId && config.intervalMs > 0) {
      upsertProactive(config);
    }
  }

  refreshKeepAlive();
}

function readPushPayload(event: PushEvent): any | null {
  if (!event.data) return null;

  try {
    return event.data.json();
  } catch {
    try {
      return { message: event.data?.text() };
    } catch {
      return null;
    }
  }
}

function openInboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_MSG_DB_NAME, ACTIVE_MSG_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // Main thread or another SW connection holds the DB at a lower version and isn't closing.
      // Push will fail to persist; reject rather than hang forever so event.waitUntil unblocks.
      reject(new Error('IndexedDB open blocked (older version still open elsewhere)'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ACTIVE_MSG_INBOX_STORE)) {
        db.createObjectStore(ACTIVE_MSG_INBOX_STORE, { keyPath: 'messageId' });
      }
      // Phase 2 Round 1: additive schema for agentic-loop / reasoning correlation. SW only writes
      // `inbox` today, but it must own the schema for these stores so it can fire its own upgrade
      // (and so an SW-first-install can still create them without main thread being open).
      if (!db.objectStoreNames.contains(ACTIVE_MSG_OUTBOUND_SESSIONS_STORE)) {
        db.createObjectStore(ACTIVE_MSG_OUTBOUND_SESSIONS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE)) {
        db.createObjectStore(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(ACTIVE_MSG_REASONING_BUFFER_STORE)) {
        db.createObjectStore(ACTIVE_MSG_REASONING_BUFFER_STORE, { keyPath: 'sessionId' });
      }
    };
  });
}

// ─── content / inbox (kind=content 老路径, tool_request 的 prefix 也走这里) ───

async function saveContentToInbox(payload: any) {
  const charId = payload?.metadata?.charId;
  const charName = payload?.contactName || payload?.metadata?.charName || '主动消息';
  const body = String(payload?.message || payload?.body || '').trim();
  const messageId = String(payload?.messageId || `${charId || 'unknown'}-${Date.now()}`);
  const payloadTimestamp = payload?.timestamp;
  const parsedSentAt = payloadTimestamp ? new Date(payloadTimestamp).getTime() : NaN;
  const sentAt = Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now();

  // 唯一不可恢复的是没 charId — 没法路由, 直接丢. 其它形态都接受:
  //   - body 非空 + directives 空 = 普通 content push (老路径)
  //   - body 非空 + directives 非空 = content + 副作用混合 push
  //   - body 空 + directives 非空 = directive-only push (LLM 只输 [[ACTION:POKE]] 等)
  //   - body 空 + directives 空 = worker bug 推白条 → 写一条空 entry, flushInbox 跑空管线无害,
  //     最多让 OSContext 弹一句默认 toast. 这种 case 应该在 worker 端修, SW 不二次验证契约.
  if (!charId) return;

  const db = await openInboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTIVE_MSG_INBOX_STORE, 'readwrite');
    tx.objectStore(ACTIVE_MSG_INBOX_STORE).put({
      messageId,
      charId,
      charName,
      body,
      avatarUrl: payload?.avatarUrl,
      source: payload?.source,
      messageType: payload?.messageType,
      messageSubtype: payload?.messageSubtype,
      taskId: payload?.taskId ?? null,
      // sessionId / messageIndex 放到 metadata 里, 主线程 flushInboxToChat 反查 reasoning_buffer
      // + 标记是第几条 (第 1 条才挂 metadata.thinkingChain).
      metadata: {
        ...(payload?.metadata || {}),
        sessionId: payload?.sessionId,
        messageIndex: payload?.messageIndex,
        totalMessages: payload?.totalMessages,
      },
      sentAt,
      receivedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await notifyClients({
    type: 'active-msg-received',
    charId,
    charName,
    body,
    avatarUrl: payload?.avatarUrl,
    sentAt,
  });
}

// ─── reasoning_buffer (kind=reasoning, 主线程 claim) ─────────────────────────

async function saveReasoningToBuffer(payload: any) {
  const sessionId: string | undefined = payload?.sessionId;
  const charId: string | undefined = payload?.metadata?.charId;
  const reasoningContent: string = String(payload?.reasoningContent ?? '');
  if (!sessionId || !charId || !reasoningContent) return;

  // 0.8.0-next.2 ReasoningPush 自带 (messageIndex, totalMessages, chunkIndex, totalChunks);
  // 老 worker 没这些字段, 兜底 (1, 1) 让单 chunk 也能走累积路径而不需要双分支.
  // 如果老 worker 罕见地多次推同 sessionId, 多条 chunks 都落在 key=(1,1) — claimReasoning
  // 排序时 V8/Safari/Firefox 的 Array#sort 是 stable 的, 保留 push 顺序 = 到达顺序.
  const messageIndex = Number.isFinite(payload?.messageIndex) ? Number(payload.messageIndex) : 1;
  const chunkIndex = Number.isFinite(payload?.chunkIndex) ? Number(payload.chunkIndex) : 1;

  // read-modify-write: 取出已有 chunks → push 新条目 → put 回去. 单事务保证原子.
  const db = await openInboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTIVE_MSG_REASONING_BUFFER_STORE, 'readwrite');
    const store = tx.objectStore(ACTIVE_MSG_REASONING_BUFFER_STORE);
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const existing = getReq.result as
        | { sessionId: string; charId: string; reasoningContent?: string; chunks?: Array<{ messageIndex: number; chunkIndex: number; reasoningContent: string }>; receivedAt: number }
        | undefined;
      // 升级路径兼容: 老 SW (≤1.5.2) 写的是扁平 reasoningContent 字段, 新 SW 第一次
      // 遇到同 sessionId 时把它转成一条 chunks 条目 (用最小 index 排在最前), 避免静默丢.
      const seed = (!existing?.chunks && existing?.reasoningContent)
        ? [{ messageIndex: 0, chunkIndex: 0, reasoningContent: existing.reasoningContent }]
        : (existing?.chunks ?? []);
      const chunks = [...seed];
      chunks.push({ messageIndex, chunkIndex, reasoningContent });
      store.put({
        sessionId,
        charId,
        chunks,
        receivedAt: Date.now(),
      });
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('reasoning buffer write aborted'));
  });
  // reasoning push 不通知客户端 — 主线程在处理同 sessionId 的 content 时会主动 claim.
}

/**
 * 清空同 sessionId 的 reasoning_buffer.
 * 镜像主应用 `applyAssistantPostProcessing` 跨 LLM round 的 `data = newResponse` 覆盖语义:
 * 早期 round 的 reasoning (工具规划阶段的内心戏) 不应混入最终一轮的 thinking chain.
 */
async function clearReasoningBuffer(sessionId: string) {
  if (!sessionId) return;
  const db = await openInboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTIVE_MSG_REASONING_BUFFER_STORE, 'readwrite');
    tx.objectStore(ACTIVE_MSG_REASONING_BUFFER_STORE).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('reasoning buffer clear aborted'));
  });
}

// ─── pending_tool_calls (kind=tool_request, 主线程 runner 跑) ────────────────

async function savePendingToolCall(payload: any) {
  const sessionId: string | undefined = payload?.sessionId;
  const charId: string | undefined = payload?.metadata?.charId;
  const toolCalls = Array.isArray(payload?.toolCalls) ? payload.toolCalls : [];
  if (!sessionId || !charId || toolCalls.length === 0) return;

  // 进入新 LLM round 前清空老 reasoning — 这一轮的 reasoning 是"工具规划"性质,
  // 不属于最终给用户看的 thinking chain. claimReasoning 永远只读到最后一轮的 chunks.
  await clearReasoningBuffer(sessionId).catch((e) => {
    console.warn('[amsg] clearReasoningBuffer before tool_request failed', e);
  });

  // iteration 来自 worker hook metadata.iteration (Round 2 worker 一定带), 兜底 0 防老 worker.
  // 客户端 /continue 时取它 + 1; 多轮 tool 链路里 iteration 单调递增, worker 也按它做 fail-fast 400.
  const iteration = Number.isFinite(payload?.metadata?.iteration) ? Number(payload.metadata.iteration) : 0;

  const db = await openInboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE, 'readwrite');
    tx.objectStore(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE).put({
      sessionId,
      charId,
      toolCalls,
      llmOutputText: String(payload?.message || ''),
      iteration,
      createdAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function notifyVisibleClientForToolRequest(payload: any) {
  // 找一个 visible window: 在线 visible → postMessage 让 main 立即跑 runner.
  // 否则展示通知, 让用户点开应用; 启动时 ActiveMsgRuntime.init 会消费 pending_tool_calls.
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visibleClient = clients.find((c) => (c as WindowClient).visibilityState === 'visible');

  if (visibleClient) {
    visibleClient.postMessage({
      type: 'instant-tool-request',
      sessionId: payload?.sessionId,
      charId: payload?.metadata?.charId,
    });
    return;
  }

  const charName = payload?.contactName || payload?.metadata?.charName || '主动消息';
  const preview = String(payload?.message || '').slice(0, 40);
  try {
    await sw.registration.showNotification(charName, {
      body: preview ? `${preview}…  (点开继续)` : '我想查点东西，点开继续',
      icon: payload?.avatarUrl || './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { payload, kind: 'tool_request' },
      tag: `instant-tool-${payload?.sessionId}`,
    });
  } catch (e) {
    console.warn('[amsg] tool_request notification failed', e);
  }
}

// emotion_update push: worker 跑完副 API 情绪评估后推回的 buff 结果. 静默写进 inbox (不弹通知、
// 不计未读), 客户端 flushInboxToChat 看到 messageType==='emotion_update' 时调 applyEmotionEvalRaw
// 落 buff + 广播 innerState, 不渲染成聊天消息. notifyClients 仅用来触发一次 flush (前台时立即落 buff;
// 后台时 postMessage 排队/丢弃, 回前台 visibilitychange flush 兜底).
async function saveEmotionUpdateToInbox(payload: any) {
  const charId = payload?.metadata?.charId;
  // emotionRaw 允许为空: worker 评估失败/返回空时也会推一条 "done" 信号 (emotionRaw=''),
  // 仍需写 inbox + notify, 让客户端 flush 时 fire 'instant-emotion-done' 熄灭 "情绪分析中" 徽章.
  const emotionRaw = payload?.metadata?.emotionRaw || '';
  if (!charId) return;
  const messageId = String(payload?.messageId || `${charId}-emotion-${Date.now()}`);

  const db = await openInboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTIVE_MSG_INBOX_STORE, 'readwrite');
    tx.objectStore(ACTIVE_MSG_INBOX_STORE).put({
      messageId,
      charId,
      charName: payload?.contactName || '',
      body: '',
      messageType: 'emotion_update',
      metadata: { charId, emotionRaw },
      sentAt: Date.now(),
      receivedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // 触发客户端 flush (不带真实内容, 客户端 flush 时按 messageType 静默处理). 不 showNotification.
  await notifyClients({ type: 'active-msg-received', charId, charName: payload?.contactName || '', body: '', emotionUpdate: true });
}

// content push: 没有可见 client 时 (后台 / PWA 被关 / 移动端冻结) 补一条系统通知, 否则用户
// 无从得知回复已到, 不会回前台 → inbox 不 flush → 客户端副作用 (写 Notion / 飞书日记等
// directive) 永远跑不了. 与 notifyVisibleClientForToolRequest 同策略: 有可见 client 就交给
// in-app UI (前台 toast), 不弹系统通知 (避开 iOS 前台双弹).
//
// 去重: web 端 active-msg 的系统通知唯一来源就是这里 — 主线程 OSContext active-msg handler
// 只在可见时弹 in-app toast, 它调的 sendProactiveNativeNotification 是 Capacitor-only (web no-op),
// 所以前台 toast / 后台系统通知互斥不重叠. 见 OSContext 注释 "SW push handler 已经 fire 过系统通知".
//
// per-char tag → 同一角色一个 turn 的多条 chunk 通知互相替换, 只露最新一条预览, 不刷屏.
async function notifyClosedClientForContent(payload: any) {
  const preview = String(payload?.message || payload?.body || '').replace(/\s+/g, ' ').trim();
  // directive-only / 空 body push 不弹 (正文 chunk 已经弹过, 别用空预览把它替换掉).
  if (!preview) return;

  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visibleClient = clients.find((c) => (c as WindowClient).visibilityState === 'visible');
  if (visibleClient) return;

  const charName = payload?.contactName || payload?.metadata?.charName || '主动消息';
  const charId = payload?.metadata?.charId || '';
  try {
    await sw.registration.showNotification(charName, {
      body: preview.slice(0, 120),
      icon: payload?.avatarUrl || './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { payload, kind: 'content' },
      tag: `active-msg-${charId}`,
    });
  } catch (e) {
    console.warn('[amsg] content notification failed', e);
  }
}

// ─── _blob envelope (fetch real body, recurse) ───────────────────────────────

async function fetchBlobEnvelope(payload: any): Promise<any | null> {
  const url = payload?.url;
  if (typeof url !== 'string' || !url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[amsg] blob fetch returned', res.status, url);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('[amsg] blob fetch failed', url, e);
    return null;
  }
}

// ─── 路由总入口 ──────────────────────────────────────────────────────────────

async function saveIncomingActiveMessage(payload: any) {
  // 1. blob envelope: 真正 body 在 BlobStore 里, fetch 出来后用 body 继续路由.
  // 重投递的 dedup 由主线程处理 (consumePendingToolCalls / inbox 都是原子 claim).
  if (payload?._blob === true) {
    const real = await fetchBlobEnvelope(payload);
    if (!real) return;
    return saveIncomingActiveMessage(real);
  }

  // 2. 按 messageKind 分轨; 兜底: 老 worker (0.6.x) 推过来的没 messageKind 字段, 当 content 处理.
  const messageKind: string = payload?.messageKind ?? 'content';

  switch (messageKind) {
    case 'content':
      await saveContentToInbox(payload);
      await notifyClosedClientForContent(payload);
      return;

    case 'reasoning':
      await saveReasoningToBuffer(payload);
      return;

    case 'emotion_update':
      await saveEmotionUpdateToInbox(payload);
      return;

    case 'tool_request':
      await savePendingToolCall(payload);
      // tool_request 也可能带 prefix (worker hook 把数据标签前的 narration 放进 message),
      // 走 content 路径让前置 narration 立刻显示 + 触发 applyAssistantPostProcessing 走副作用.
      if (payload?.message) await saveContentToInbox(payload);
      await notifyVisibleClientForToolRequest(payload);
      return;

    case 'error':
      // 诊断 push: 不写 inbox, 不弹通知, 仅 log + 通知任意 visible client 把 error 渲染到 toast.
      console.error('[amsg] error push', payload?.code, payload?.message);
      await notifyClients({
        type: 'active-msg-error',
        code: payload?.code,
        message: payload?.message,
        charId: payload?.metadata?.charId,
      });
      return;

    default:
      console.warn('[amsg] unknown messageKind, falling back to content', messageKind);
      await saveContentToInbox(payload);
  }
}

sw.addEventListener('push', (event: PushEvent) => {
  const payload = readPushPayload(event);
  if (!payload) return;

  event.waitUntil(saveIncomingActiveMessage(payload));
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  const payload = event.notification.data?.payload || event.notification.data || {};
  const charId = payload?.metadata?.charId || payload?.charId || '';
  event.notification.close();

  event.waitUntil((async () => {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      const client = clients[0];
      await client.focus();
      client.postMessage({ type: 'active-msg-open', charId });
      return;
    }

    const openUrl = new URL(sw.registration.scope || sw.location.origin);
    openUrl.searchParams.set('openApp', 'chat');
    if (charId) openUrl.searchParams.set('activeMsgCharId', charId);
    await sw.clients.openWindow(openUrl.toString());
  })());
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const { type } = event.data || {};

  switch (type) {
    case 'GET_SW_VERSION':
      // BuildBadge 通过 MessageChannel + port 协议查询；不响应时 BuildBadge 显示 sw@?
      event.ports[0]?.postMessage({ version: SW_VERSION });
      break;
    case 'keepalive-start':
      startKeepAlive();
      break;
    case 'keepalive-stop':
      stopKeepAlive();
      break;
    case 'proactive-start':
      if (event.data.config) {
        syncProactive([...proactiveSchedules.values(), event.data.config]);
      }
      break;
    case 'proactive-stop':
      if (event.data.charId) {
        stopProactive(event.data.charId);
        refreshKeepAlive();
      } else {
        syncProactive([]);
      }
      break;
    case 'proactive-sync':
      syncProactive(event.data.configs || []);
      break;
  }
});

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
});
