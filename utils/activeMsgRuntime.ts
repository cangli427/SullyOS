import { ActiveMsg2InboxMessage, APIConfig, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';
import {
  applyAssistantPostProcessing,
  type PostProcessDirective,
  type XhsCaches,
} from './applyAssistantPostProcessing';
import { runPendingToolCalls } from './instantToolRunner';
import { processNewMessages } from './memoryPalace/pipeline';
import { evaluateEmotionBackground } from '../hooks/useChatAI';

let initialized = false;

// Phase 1: 用 module-level ref 缓存 XHS 跨消息 token (与 useChatAI 行为对齐)。
// 跨整个 push 路径共享, 不每条 inbox 消息重建; XHS 在 push 路径默认被 skipSecondPassLLM
// 跳过, 所以这里实际上始终是空 Map, 留着是为了满足 ctx 接口契约。
const pushXhsCaches: XhsCaches = {
  xsecTokenCache: new Map(),
  noteTitleCache: new Map(),
  commentUserIdCache: new Map(),
  commentAuthorNameCache: new Map(),
  commentParentIdCache: new Map(),
};

type MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number };
  lightLLM: { baseUrl: string; apiKey: string; model: string };
};

/** 从 localStorage 读 memoryPalaceConfig — OSContext 同步存的是 os_memory_palace_config key */
const loadMemoryPalaceConfigFromLocalStorage = (): MemoryPalaceGlobalConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_memory_palace_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as MemoryPalaceGlobalConfig;
  } catch {
    return undefined;
  }
};

/** 从 localStorage 读 APIConfig (与 OSContext load 逻辑保持一致, 但这里在 React 之外跑) */
const loadApiConfigFromLocalStorage = (): APIConfig => {
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
};

/** 从 localStorage 读 RealtimeConfig — 整个 push 路径里我们不会再回连 LLM, 但 ChatParser
 *  及 DIARY 写入(可执行的副作用)需要这些配置, 缺失时返回 undefined 让消费方走 fallback。 */
const loadRealtimeConfigFromLocalStorage = (): RealtimeConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_realtime_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    return undefined;
  }
};

/**
 * 用 applyAssistantPostProcessing 把 push 收到的 inbox message 走一遍 13 步管线。
 * skipSecondPassLLM=true: 不回连 LLM (worker 现在还没续跑能力, Phase 2 才解决),
 * 二轮标签 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) 留在
 * 原文里, 由 ChatParser.sanitize 等步骤兜底剥掉。
 * 副作用类标签 (POKE / TRANSFER / ADD_EVENT / schedule_message / 写日记) 仍会执行。
 * 失败时抛出, 由调用方决定是否重新入队。
 */
const processInboxMessageWithPostProcessing = async (message: ActiveMsg2InboxMessage): Promise<void> => {
  const characters = await DB.getAllCharacters();
  const char = characters.find(c => c.id === message.charId);
  if (!char) {
    throw new Error(`character not found for charId=${message.charId}`);
  }

  const userProfile: UserProfile = (await DB.getUserProfile())
    ?? { name: 'User', avatar: '', bio: '' };
  const emojis = await DB.getEmojis();
  const contextMsgs = await DB.getRecentMessagesByCharId(message.charId, 200);

  const apiConfig = loadApiConfigFromLocalStorage();
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // Phase 1: 副作用 (DIARY 写入等) 会调 DB.saveMessage, 它内部已经 fire 'messages-updated' 事件;
  // 但 OSContext 真正驱动 chat UI 重新 reloadMessages 的是 lastMsgTimestamp, 而那个 state 现在
  // 只由 'active-msg-received' handler 改。为了让 push 路径下的 per-chunk 落库也立刻反映到 UI,
  // 用一个独立的 side-channel 事件 'active-msg-progress': OSContext 监听它后只 setLastMsgTimestamp,
  // 不 fire toast / 不增加未读 / 不 resolve sendInstantPush 的 one-shot promise。
  // 单条 inbox message 进来时 fire 一次 'active-msg-received' 即可保证 toast / 未读 / 通知一次发生。
  const dispatchProgress = () => {
    window.dispatchEvent(new CustomEvent('active-msg-progress', {
      detail: { charId: message.charId },
    }));
  };

  // Phase 2 Round 2: 如果 worker 自动发的 ReasoningPush 已经被 SW 写到 reasoning_buffer,
  // 在处理"这个 sessionId 的第一条 content"时把 reasoning_content 反取出来挂到 ctx, 让 thinking
  // chain 卡片渲染到第一条 assistant message 的 metadata.thinkingChain.
  // Round 1 worker 在 0.6 one-shot 时不发 reasoning push, claimReasoning 始终返回 null — 无副作用.
  // messageIndex 来源: SW 在 saveContentToInbox 把 payload.messageIndex 写到 metadata. Round 2
  // worker 用 1-based (buildContentPush 第 1 条 → messageIndex=1); 老 worker 没这个字段, ?? 0 fallback.
  // 只对 first content claim (避免 N 条 push 同 session 时重复读 / 第 2 条挂错 metadata).
  const sessionId: string | undefined = (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
  const messageIndex: number = (message as any).messageIndex
    ?? (message.metadata && (message.metadata as any).messageIndex)
    ?? 0;
  let reasoningContent: string | undefined;
  if (sessionId && messageIndex <= 1) {
    try {
      const buffered = await ActiveMsgStore.claimReasoning(sessionId);
      reasoningContent = buffered?.reasoningContent;
    } catch (e) {
      console.warn('[ActiveMsg] claimReasoning failed', sessionId, e);
    }
  }

  await applyAssistantPostProcessing(message.body || '', {
    char,
    userProfile,
    emojis,
    realtimeConfig,
    contextMsgs,
    // fullMessages / initialData: worker 不会传过来 (Phase 2 才有续跑), 二轮 LLM 又被关掉,
    // 这两个字段在 skipSecondPassLLM=true 时实际上不会被消费; 给个最小占位避免 undefined NPE。
    fullMessages: [],
    initialData: null,
    historyMsgCount: contextMsgs.length,
    // 把 source / activeMsg2 元数据通过 mcdInheritMeta 继承到每条 assistant message, 这样
    // UI 还能区分 "这条是 push 来的"。
    mcdInheritMeta: {
      source: 'active_msg_2',
      activeMsg2: {
        messageId: message.messageId,
        taskId: message.taskId,
        messageType: message.messageType,
        messageSubtype: message.messageSubtype,
        avatarUrl: message.avatarUrl,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
      },
      ...(message.metadata || {}),
    },
    xhsCaches: pushXhsCaches,
    api: {
      baseUrl: apiConfig.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
      },
      // effectiveApi 在 push 路径里没人读 — skipSecondPassLLM=true 把所有二轮 LLM 入口都堵了。
      // 留着只为满足 ctx 类型形状; Phase 2 worker 走续跑时也不会让客户端再发 LLM 请求, 所以这里
      // 长期就是个空架子, 不要花精力同步 os_api_presets / os_available_models 等运行时切换。
      effectiveApi: {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
      },
    },
    hooks: {
      // setMessages 在 React 外面跑, 没法直接 setState, 只 fire 一次 progress 事件让
      // OSContext 推 lastMsgTimestamp, 然后 Chat.tsx 自然 reloadMessages 重新读库。
      setMessages: () => { dispatchProgress(); },
      // push 路径 deliberately 静默 toast — 避免在用户没在 chat 这个角色时狂弹 toast。
      // 如果真要给用户可见反馈, 应该走 'active-msg-received' 那条线 (toast / 未读 / 通知)。
      addToast: (msg: string, type: 'info' | 'success' | 'error') => {
        console.log('[push:toast]', type, msg);
      },
      // 不传 musicHooks: ChatParser 检测到没钩子时会静默丢弃 MUSIC_ACTION 标签 (chatParser.ts:155)。
      // Phase 1 接受 "push 来的消息看不到音乐卡片" 这个 trade-off, Phase 2 再补回来。
    },
    skipSecondPassLLM: true,
    // 把 worker hook 塞进 metadata.directives 的副作用结构化重放出来 (POKE/TRANSFER/ADD_EVENT/
    // schedule_message/MUSIC_ACTION/XHS_*). applyAssistantPostProcessing 会反向拼回 tag 喂给
    // chatParser + 内联 XHS handler.
    // amsg-instant 0.8.0-next.4 起一个 user turn 可能产 N 条 push, directives 只应该
    // replay 一次. worker buildPushDecision 把 directives 挂在最后一条 push 上,
    // 这里加 isLastChunk 守卫双保险, 防未来 worker bug 在多条 push 都塞 directives.
    // 老 worker (无 messageIndex/totalMessages 字段) ?? 0 fallback, 0===0 也算 last.
    directives: isLastChunk(message) ? extractDirectives(message) : [],
    reasoningContent,
  });

  // ─── Phase 2 Round 2 (2f): Memory Palace + emotion eval 尾段 ───
  // 这一段跟 useChatAI.ts:finally 字节级对齐 — push 路径走完 applyAssistantPostProcessing
  // (落库 + chunks) 后, 把 Memory Palace 缓冲区 + 情绪评估也跑一遍, 否则 push 来的消息会被
  // palace 永久漏掉 / buff 不更新. 非阻塞: 都用 .catch 包 (Memory Palace pipeline 自带并发锁,
  // emotion eval 是 fire-and-forget). 失败只 log, 不抛.
  await runPushTailPipeline(message, char, userProfile, contextMsgs);
};

/**
 * 这条 inbox message 是不是它所在 session 的**最后一条 chunk**.
 * messageIndex == totalMessages → 最后一条 ✓
 * 都缺失 (老 worker / proactive push 单 push) → 0 === 0 也认 last
 */
function isLastChunk(message: ActiveMsg2InboxMessage): boolean {
  const mi = Number(message.metadata?.messageIndex ?? 0);
  const tm = Number(message.metadata?.totalMessages ?? 0);
  return mi === tm;
}

/** 把 worker 推给的 directives 从 inbox message metadata 里挖出来; 没有就空数组. */
function extractDirectives(message: ActiveMsg2InboxMessage): PostProcessDirective[] {
  const raw = message.metadata && (message.metadata as any).directives;
  if (!Array.isArray(raw)) return [];
  // 字段形状由 worker classifier 保证 (跟 PostProcessDirective union 一致); 这里只做轻量校验
  // 防 metadata 被改坏. 不识别的 type 不抛错, applyAssistantPostProcessing 内部 default 分支会 warn.
  return raw.filter((d) => d && typeof d === 'object' && typeof (d as any).type === 'string');
}

/**
 * 跑 push 路径的尾段: Memory Palace 缓冲区处理 + 情绪评估.
 *
 * 这两块在 useChatAI 里都依赖 React state/refs 注入 (charRef / setMemoryPalaceStatus /
 * setEvolvedNarrative / setEmotionStatus). 在 React 外面跑时降级:
 *   - charRef 检查 → 直接用 push 时拿到的 char (不存在"用户切角色"的并发, push 是被动消费)
 *   - setMemoryPalaceStatus → no-op (UI 没法显示这个状态, palace 自带并发锁仍能保证不重入)
 *   - setEvolvedNarrative → 写回 char.evolvedNarrative 经 DB.saveCharacter 持久化, 让下次 send
 *     时本地 fetch 路径读到 (跟 React 内 setEvolvedNarrative 后被 effect 写回 DB 等价)
 *   - autoArchive / 50 轮认知消化: 跟 React 内逻辑一样, 但这些已经在 pipeline.then 内部 self-contained
 */
async function runPushTailPipeline(
  message: ActiveMsg2InboxMessage,
  char: import('../types').CharacterProfile,
  userProfile: UserProfile,
  contextMsgs: import('../types').Message[],
): Promise<void> {
  // 1. Memory Palace
  const mpConfig = loadMemoryPalaceConfigFromLocalStorage();
  const mpEmb = mpConfig?.embedding;
  const mpLLMConfigured = mpConfig?.lightLLM;
  const apiConfig = loadApiConfigFromLocalStorage();
  const mpLLM = (mpLLMConfigured?.baseUrl)
    ? mpLLMConfigured
    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };

  if ((char as any).memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
    try {
      const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
      // fire-and-forget: pipeline 内部有并发锁 + 水位线检查, 不会抢着跑两份
      void processNewMessages(
        recentMsgs,
        char.id,
        char.name,
        mpEmb,
        mpLLM,
        userProfile?.name || '',
        false,
        (stage) => { console.log('[push:memory-palace]', stage); },
      ).catch((e) => {
        console.warn('[push:memory-palace] processNewMessages failed', e);
      });
    } catch (e) {
      console.warn('[push:memory-palace] tail kickoff failed', e);
    }
  }

  // 2. 情绪评估 (innerState 演化)
  // useChatAI 那边的 gate: isScheduleFeatureOn(char) && char.emotionConfig?.enabled. push 路径只取
  // emotionConfig.enabled — isScheduleFeatureOn 跟 char.scheduleStyle 强相关, 在 React 外面拉运行时
  // ref 太啰嗦, 简化成"角色开了 emotionConfig 就跑"; 误差是 schedule off 但 emotionConfig on 的边缘配置
  // 也会触发, 业务上无害.
  const emotionConfig = (char as any).emotionConfig;
  if (emotionConfig?.enabled) {
    const emotionApi = (emotionConfig.api?.baseUrl)
      ? emotionConfig.api
      : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
    // mainSystemPrompt + apiMessages: 我们没法重建 useChatAI 那一套精确的 systemPrompt (会包括 buff
    // 注入 / 世界书 / persona / live context 等), push 路径用一个最小版替代: char.systemPrompt + 最近
    // 50 条聊天作为 apiMessages, 让情绪 eval 看到的是"角色定义 + 近期对话". 评估精度比 fetch 路径低,
    // 但能正确驱动 buff/innerState 演化方向. 后续可改成把 outbound_session.messages 喂进来.
    const apiMessages = contextMsgs.slice(-50).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    }));
    const systemPrompt = char.systemPrompt || '';
    try {
      const innerState = await evaluateEmotionBackground(char, userProfile, systemPrompt, apiMessages, emotionApi);
      if (innerState) {
        // 写回角色 evolvedNarrative — useChatAI 走 setEvolvedNarrative React state 后被 OSContext
        // effect 同步到 DB 的, 这里直接 DB.saveCharacter 短路, 下次 send 时被读取注入 prompt.
        try {
          const latest = (await DB.getAllCharacters()).find((c) => c.id === char.id);
          if (latest) {
            await DB.saveCharacter({ ...latest, evolvedNarrative: innerState } as any);
          }
        } catch (e) {
          console.warn('[push:emotion-eval] saveCharacter failed', e);
        }
      }
    } catch (e) {
      console.warn('[push:emotion-eval] evaluateEmotionBackground failed', e);
    }
  }

  // 顺手通过 message 触发 'emotion-updated' (跟 useChatAI line 382 一致), 让 UI 重新读 char
  try {
    window.dispatchEvent(new CustomEvent('emotion-updated', { detail: { charId: char.id } }));
  } catch { /* SSR-safe / not browser, ignore */ }
}

const flushInboxToChat = async () => {
  const pendingMessages = await ActiveMsgStore.consumeInboxMessages();
  // consumeInboxMessages 是 "先 ack 后处理" 语义 —— inbox 已经原子地清空。
  // 这里 per-message try/catch: 单条处理抛错 (quota / DB 故障 / postprocess 异常) 不连累
  // 后续条目。Phase 1 改成: 先尝试走 applyAssistantPostProcessing (与本地 fetch 路径
  // 行为对齐 — emoji / 翻译 / HTML / 引用 / chunking 全部复用同一管线); 如果走管线失败,
  // 降级回原来的 "原文一次性 saveMessage" 防止消息丢失。dispatchEvent 始终 fire 一次,
  // 保证 toast / 未读 / 通知 / sendInstantPush resolver 语义不变。
  for (const message of pendingMessages) {
    const messageTimestamp = message.sentAt || message.receivedAt || Date.now();

    // 白名单制: AI 文本类型基本封闭 (amsg-shared MESSAGE_TYPE 4 个 + SullyOS 3 个 legacy 别名);
    // 非 AI 类型 (forum / event / system / 未来扩展) 不可枚举, 不进 post-processing 防把它们当 AI 输出乱解析.
    // Phase 1 老白名单只列了 text/assistant/normal, 漏了整个 amsg-shared 集合, 导致所有 push 都
    // 走 raw fallback (post-processing / directive 重放 / emoji / chunking 全部跳过). Round 2 补全.
    const ASSISTANT_TEXT_TYPES = new Set([
      // SullyOS legacy
      'text', 'assistant', 'normal',
      // amsg-shared MESSAGE_TYPE union (instant/fixed/prompted/auto) — 全是 LLM 输出
      'instant', 'fixed', 'prompted', 'auto',
    ]);
    const looksLikeAssistantText = !message.messageType
      || ASSISTANT_TEXT_TYPES.has(message.messageType);

    let routed = false;

    if (looksLikeAssistantText) {
      try {
        await processInboxMessageWithPostProcessing(message);
        routed = true;
      } catch (postErr) {
        console.warn('[ActiveMsg] post-processing failed, falling back to raw save', message.messageId, postErr);
        // 落库失败: 有可能 post-processing 中途已经写了部分 chunk 进 DB, 这里再 raw save 一遍
        // 会重复; 但中途失败时通常是初始化阶段就挂了 (char 找不到 / DB 故障), 部分写入概率低。
        // 为了不丢消息, 仍尝试 raw save; 若它也失败, 会进下面的 catch 把消息 requeue。
        // TODO(Phase 2): worker 续跑落地后, 这里的"部分写入 + raw save 重复"窗口要改成基于
        // sessionId 的 dedupe (worker push payload 会带稳定 id), 而不是依赖低概率假设。
      }
    }

    if (!routed) {
      try {
        await DB.saveMessage({
          charId: message.charId,
          role: 'assistant',
          type: 'text',
          content: message.body,
          timestamp: messageTimestamp,
          metadata: {
            source: 'active_msg_2',
            activeMsg2: {
              messageId: message.messageId,
              taskId: message.taskId,
              messageType: message.messageType,
              messageSubtype: message.messageSubtype,
              avatarUrl: message.avatarUrl,
              sentAt: message.sentAt,
              receivedAt: message.receivedAt,
            },
            ...(message.metadata || {}),
          },
        });
      } catch (e) {
        console.warn('[ActiveMsg] saveMessage failed, requeue to inbox', message.messageId, e);
        try {
          await ActiveMsgStore.saveInboxMessage(message);
        } catch (reputErr) {
          // re-put 也挂了 (大概率同一根因, 比如 quota / DB 关停), 没救了, 至少留个日志
          console.error('[ActiveMsg] requeue failed, message lost', message.messageId, reputErr);
        }
        // requeue 后跳过这条消息的 dispatchEvent —— UI 不该误以为收到了
        continue;
      }
    }

    // 不管走 post-processing 还是 raw fallback, 单条 inbox message 触发一次 'active-msg-received',
    // 保留原有 toast / 未读 / 通知 / sendInstantPush resolver 语义。body 用原文做预览即可。
    window.dispatchEvent(new CustomEvent('active-msg-received', {
      detail: {
        charId: message.charId,
        charName: message.charName,
        body: message.body,
        avatarUrl: message.avatarUrl,
        sentAt: messageTimestamp,
      },
    }));
  }
};

// Phase 2 Round 2: 真实 tool runner. 启动时排空 + SW postMessage 触发. 失败诊断在 instantToolRunner 内.
const runPendingToolCallsSafely = async () => {
  try {
    await runPendingToolCalls();
  } catch (e) {
    console.warn('[instant-push] runPendingToolCalls failed', e);
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    window.history.replaceState({}, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type === 'active-msg-received') {
          void flushInboxToChat();
          return;
        }

        // Phase 2 Round 2: SW 收到 tool_request push 且当前 window visible → 立即跑 runner.
        // 不 visible 时 SW 发的是 showNotification, 用户点击后落到 active-msg-open 分支,
        // ActiveMsgRuntime.init 时这里的启动消费会兜底 (runPendingToolCallsSafely).
        if (type === 'instant-tool-request') {
          void runPendingToolCallsSafely();
          return;
        }

        if (type === 'active-msg-open') {
          void flushInboxToChat().then(() => {
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
          });
          // notification → open 路径里大概率刚好有一条 pending_tool_call 等着 (visibility=false
          // 时 SW 走的通知支线), 顺手消费一次.
          void runPendingToolCallsSafely();
        }
      });
    }

    await runPendingToolCallsSafely();
    await flushInboxToChat();
    handleDeepLink();
  },
};
