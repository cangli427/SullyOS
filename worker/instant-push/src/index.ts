/**
 * SullyOS Instant Push — Cloudflare Worker entry.
 *
 * Phase 2 Round 2 (这次):
 *  - 升 @rei-standard/amsg-instant 到 ^0.8.0-next.3
 *  - 配置 onLLMOutput hook: SullyOS 业务标签分类器 (见 ./classifier.ts)
 *  - 数据标签 → tool-request push (客户端跑工具, POST /continue 续跑)
 *  - 副作用标签 → finish + metadata.directives (客户端重放)
 *  - reasoning_content 由 amsg-instant 自动 emit ReasoningPush, 我们不碰
 *  - 可选 D1 BlobStore: 部署时给 worker 加 `DB` binding 即启用, 否则 push 超 2.6KB 会 500
 *
 * 入口仍是 createCloudflareWorker 工厂, env 在请求级注入 (secrets 在 wrangler.toml 外配置).
 */

import { createCloudflareWorker } from '@rei-standard/amsg-instant/adapters/cloudflare';
import { createD1BlobStore } from '@rei-standard/amsg-instant/blob/d1';
import {
  buildContentPush,
  buildToolRequestPush,
  MESSAGE_TYPE,
  PUSH_SOURCE,
} from '@rei-standard/amsg-shared';

import { classifyLLMOutput } from './classifier';
import { sanitizeIntoSegments, type Segment } from '../../../utils/sanitize';

export interface Env {
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_EMAIL?: string;
  AMSG_CLIENT_TOKEN?: string;
  /**
   * 可选 D1 binding. 配了就启用 BlobStore — agentic loop + reasoning 场景下
   * push payload p99 容易超 2.6 KB 安全线, 没 BlobStore 会 500 PAYLOAD_TOO_LARGE.
   * 表结构见 worker/instant-push/schema.sql.
   */
  DB?: D1Database;
}

type D1Database = {
  prepare(query: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
};

const cfWorker = createCloudflareWorker((env: Env) => {
  const blobStore = env.DB
    ? {
        adapter: createD1BlobStore(env.DB, { table: 'amsg_transient_blobs' }),
        // 用默认 2600 B / 60 s; 见 amsg-instant README §BlobStore.
      }
    : undefined;

  return {
    vapid: {
      email: env.VAPID_EMAIL || 'mailto:noreply@example.com',
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
    clientToken: env.AMSG_CLIENT_TOKEN,
    blobStore,
    maxLoopIterations: 10,
    onLLMOutput,
    onEvent: (e: { type: string; [k: string]: unknown }) => {
      // CF Workers logging — 只在异常分支打详细 log, 减少正常路径 stdout 噪音
      if (
        e.type === 'hook_threw'
        || e.type === 'loop_exceeded'
        || e.type === 'llm_call_failed'
        || e.type === 'blob_put_failed'
        || e.type === 'payload_too_large'
      ) {
        console.error('[instant-push]', e);
      }
    },
  };
});

/**
 * 双导出: fetch + scheduled. scheduled 只在 wrangler.toml 配 cron + DB binding 时
 * 被 CF 调度; 没绑 D1 时是 no-op, 不会跑.
 */
export default {
  fetch: cfWorker.fetch,
  async scheduled(_event: unknown, env: Env) {
    if (!env.DB) return;
    try {
      await env.DB.prepare('DELETE FROM amsg_transient_blobs WHERE expires_at < ?')
        .bind(Date.now())
        .run();
    } catch (e) {
      console.error('[instant-push] blob sweeper failed', e);
    }
  },
};

/**
 * onLLMOutput hook — 每轮 LLM 输出后调一次, 返 decision payload.
 *
 * Thin shim: 从 amsg-instant SessionContext 读字段 + normalize, 再委托给纯函数
 * buildPushDecision. 业务逻辑 + 边界处理都在 buildPushDecision 里 (方便单测).
 *
 * @param ctx 见 amsg-instant SessionContext: { sessionId, messages, llmOutputText,
 *            iteration, metadata, contactName, avatarUrl, llmResponse, ... }
 */
async function onLLMOutput(ctx: any) {
  return buildPushDecision({
    llmOutputText: String(ctx.llmOutputText ?? ''),
    sessionId: ctx.sessionId,
    iteration: Number(ctx.iteration ?? 0),
    contactName: ctx.contactName ?? '',
    avatarUrl: ctx.avatarUrl ?? null,
    // metadata 透传: 客户端 sendInstantPush 时塞了 charId; SW 路由要它分发到具体角色
    callerMetadata: (ctx.metadata && typeof ctx.metadata === 'object') ? ctx.metadata : {},
  });
}

// ─── Pure logic: 抽出来给单测 ──────────────────────────────────────────────

export interface PushDecisionInput {
  llmOutputText: string;
  sessionId: string;
  iteration: number;
  contactName: string;
  avatarUrl: string | null;
  callerMetadata: Record<string, unknown>;
}

export interface PushDecisionDeps {
  /** 自定义 size warn 回调; 默认走 console.warn. 测试用来 spy. */
  onSizeWarn?: (bytes: number) => void;
}

export type PushDecision =
  | { decision: 'tool-request'; pushPayloads: unknown[] }
  | { decision: 'finish'; pushPayloads: unknown[] }
  | { decision: 'skip-push' };

/**
 * 纯函数: 给 normalize 过的 ctx 字段, 出 { decision, pushPayloads }.
 *
 * amsg-instant 0.8.0-next.4 起 hook 返回 pushPayloads 数组, lib 不做 split, hook
 * 自己负责把内容切成 N 个独立 push. 我们用 sanitizeIntoSegments 把 LLM 输出
 * 切成 segments (按换行 + CJK 空格切, 跟客户端 chatParser.chunkText 一致),
 * 每个 segment 一条 push, banner 显示 sanitized 版本, message 保留 raw 让客户端
 * Step 9/5/8 渲染.
 *
 * 空输入 / sanitize 全 strip 完没剩内容时返 skip-push (没东西可发, lib 跳过这一轮).
 *
 * Tool-request: classifier 提取的 prefix 切 segments 当 content push, 再 append
 * 一条 tool_request push 在末尾 (toolCalls 在那条上). decision 跟 push 内容
 * messageKind 分布解耦, lib 不检查.
 *
 * Directives (副作用标签): finish 路径只在**最后一条** push 的 metadata 上挂,
 * 防止客户端 N 条 inbox entry 都跑一次 replay (applyAssistantPostProcessing
 * 这边也加了 messageIndex==totalMessages 守卫双保险).
 */
export function buildPushDecision(
  input: PushDecisionInput,
  deps?: PushDecisionDeps,
): PushDecision {
  const { llmOutputText, sessionId, iteration, contactName, avatarUrl, callerMetadata } = input;

  const result = classifyLLMOutput(llmOutputText);
  const baseCommon = {
    messageType: MESSAGE_TYPE.INSTANT,
    source: PUSH_SOURCE.INSTANT,
    sessionId,
    contactName,
    avatarUrl,
  };

  const trimmedContactName = (contactName || '').trim();
  const notificationTitle = `来自 ${trimmedContactName || '主动消息'}`;

  if (result.kind === 'tool-request') {
    // 把 prefix narration 切 segments. classifier 已经剥 DATA tag, prefix 里只
    // 剩 narration 文字 (可能含 SEND_EMOJI / [html] 业务标签).
    const narrationSegments = sanitizeIntoSegments(result.prefix);
    const narrationPushes = narrationSegments.map((seg, i) =>
      buildSegmentPush({ seg, baseCommon, notificationTitle, callerMetadata, iteration, chunkIdx: i, sessionId }),
    );
    // tool_request push 在末尾, message 空 (narration 已经独立成 push), toolCalls 在
    // 这条上, 不带 notification → SW tool_request 分轨不弹 banner.
    const toolPush = {
      ...buildToolRequestPush({
        ...baseCommon,
        messageId: `msg_${sessionId}_${iteration}_toolreq`,
        message: '',
        toolCalls: result.toolCalls,
        metadata: {
          ...callerMetadata,
          iteration,
        },
      }),
    };
    const pushPayloads = [...narrationPushes, toolPush];
    pushPayloads.forEach((p) => warnIfPayloadLarge(p, deps?.onSizeWarn));
    return { decision: 'tool-request', pushPayloads };
  }

  // finish
  const segments = sanitizeIntoSegments(result.cleanedText);
  if (segments.length === 0) {
    // sanitize 全 strip 完没剩 (e.g. 整段只有 <think> 和业务标签). 没 banner / 没 bubble.
    // directives 也无人挂载, 副作用就丢了 — 这是设计选择: 整段没用户可见内容就不发任何东西.
    return { decision: 'skip-push' };
  }
  const lastIdx = segments.length - 1;
  const pushPayloads = segments.map((seg, i) =>
    buildSegmentPush({
      seg,
      baseCommon,
      notificationTitle,
      callerMetadata,
      iteration,
      chunkIdx: i,
      sessionId,
      // directives 只挂在最后一条 push 上, 客户端按 messageIndex==totalMessages 守卫
      directives: i === lastIdx ? result.directives : undefined,
    }),
  );
  pushPayloads.forEach((p) => warnIfPayloadLarge(p, deps?.onSizeWarn));
  return { decision: 'finish', pushPayloads };
}

/**
 * 单 segment → 单 ContentPush. messageId 显式给唯一值 ( amsg-shared typedef
 * 要求, 不能 undefined ). next.4 lib runtime 看到 hook 已设 messageId 就不动,
 * 只对未设的自动补 _chunk_${i} 后缀.
 */
function buildSegmentPush(args: {
  seg: Segment;
  baseCommon: {
    messageType: typeof MESSAGE_TYPE.INSTANT;
    source: typeof PUSH_SOURCE.INSTANT;
    sessionId: string;
    contactName: string;
    avatarUrl: string | null;
  };
  notificationTitle: string;
  callerMetadata: Record<string, unknown>;
  iteration: number;
  chunkIdx: number;
  sessionId: string;
  directives?: unknown[];
}): unknown {
  const { seg, baseCommon, notificationTitle, callerMetadata, iteration, chunkIdx, sessionId, directives } = args;
  // notification.body 跟 message 显示文本可以不一样 (SEND_EMOJI 在 banner 上是
  // [表情：x], 在 message 里是 [[SEND_EMOJI: x]] 让客户端 Step 9 渲染 sticker).
  // 即使 sanitized === raw 也照样塞 — next.4 lib 不再 clone notification 跨 chunk,
  // 每条独立, 不会重复占 size.
  return {
    ...buildContentPush({
      ...baseCommon,
      messageId: `msg_${sessionId}_${iteration}_chunk_${chunkIdx}`,
      message: seg.raw,
      metadata: {
        ...callerMetadata,
        iteration,
        ...(directives !== undefined ? { directives } : {}),
      },
    }),
    notification: { title: notificationTitle, body: seg.sanitized },
  };
}

/**
 * 早警告水位 — amsg-instant next.2 默认 maxInlineBytes=2600, 超了就 500
 * PAYLOAD_TOO_LARGE. 2300 留 ~300B margin 给 amsg-instant wrapping 字段
 * (kind/messageKind/_blob envelope 等). 默认 console.warn, 测试可注入
 * onSizeWarn 抓 bytes 参数.
 */
function warnIfPayloadLarge(
  payload: unknown,
  onSizeWarn?: (bytes: number) => void,
): void {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (bytes > 2300) {
      if (onSizeWarn) {
        onSizeWarn(bytes);
      } else {
        console.warn('[instant-push] payload close to limit', { bytes });
      }
    }
  } catch {
    // JSON.stringify 抛 (循环引用?) 时不阻塞主流程
  }
}
