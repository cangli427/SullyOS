/**
 * 共享 sanitize 工具 — 零依赖纯字符串处理.
 *
 * 两个 facade:
 *  - sanitizeForBubble(text, opts)  — chatParser.sanitize 的实现, 给客户端 13 步管线**预处理**用.
 *    保留 SEND_EMOJI / [html] / <翻译> / <think> / [[INNER_STATE:...]] 等标签, 因为
 *    applyAssistantPostProcessing Step 4 (think chain) / Step 5 (html card) /
 *    Step 8 (双语) / Step 9 (sticker) 还要靠这些标签接管.
 *  - sanitizeForNotification(text)  — worker push 之前的**终态**处理, 没有下游 step,
 *    所以剥得更彻底: think 块 / INNER_STATE 全删, SEND_EMOJI → [表情：名称],
 *    [html]...[/html] → [HTML 卡片], <翻译> 只保留原文, 链接 → [链接：text].
 *
 * 真理来源:
 *  - 共享底层规则: utils/chatParser.ts:sanitize 原版正则 (lines 207-252)
 *  - notification 专用 / Step 9-相关规则: utils/applyAssistantPostProcessing.ts:normalizeAiContent
 */

// ─── 底层 helper (共享, 无歧义清理) ─────────────────────────────────────────

/** `\\n` 字面 → 真实换行. 必须先跑, 否则后续 ^ 行锚定失效. */
const stripLiteralBackslashN = (t: string): string => t.replace(/\\n/g, '\n');

/** 源标签 `[聊天]/[通话]/[约会]` → 换行 (保留分隔语义) */
const stripSourceTags = (t: string): string => t.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n');

/** 4 种时间格式: 带括号 ISO / 行首裸 ISO / 中文 12h / 英文 12h */
const stripTimestamps = (t: string): string =>
  t
    .replace(/\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*/gm, '')
    .replace(/（[上下]午\d{1,2}[：:]\d{2}）/g, '')
    .replace(/\(\d{1,2}:\d{2}\s*[AP]M\)/gi, '');

/** `[2024年5月20]` / `[2024/5/20...]` 中文或斜杠日期 (兼容 normalizeAiContent 的更宽松匹配) */
const stripChineseDate = (t: string): string => t.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');

/**
 * 整个字符串首行的角色名 prefix `Sully:` / `User:` (无 m flag — 跟
 * applyAssistantPostProcessing.ts:normalizeAiContent 行为对齐).
 */
const stripRoleNamePrefix = (t: string): string => t.replace(/^[\w一-龥]+:\s*/, '');

/**
 * 业务标签 (ACTION / RECALL / SEARCH / DIARY / READ_DIARY / FS_DIARY / FS_READ_DIARY /
 * DIARY_START / DIARY_END / FS_DIARY_START / FS_DIARY_END / MUSIC_ACTION) + schedule_message.
 * 保持跟 chatParser.sanitize 原版字节对齐 — 不含 READ_NOTE / XHS_x (那些只在 notification 路径剥).
 */
const stripBusinessTagsForBubble = (t: string): string =>
  t
    .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END|MUSIC_ACTION)[:\s][\s\S]*?\]\]/g, '')
    .replace(/\[schedule_message[^\]]*\]/g, '');

/**
 * notification 路径专用 — 在 stripBusinessTagsForBubble 基础上额外剥 READ_NOTE / XHS_x.
 * 这些标签在 chatParser.sanitize 老路径里被保留 (downstream 由 applyAssistantPostProcessing
 * 重新扫描+执行), 但 push notification 是终态, 不会再有 downstream, 所以剥得更狠.
 */
const stripBusinessTagsForNotification = (t: string): string =>
  stripBusinessTagsForBubble(t)
    .replace(/\[\[(?:READ_NOTE|XHS_[A-Z_]+)[:\s][\s\S]*?\]\]/g, '')
    .replace(/\[\[XHS_[A-Z_]+\]\]/g, '');

/** 引用类: `[[QUOTE|引用]] / [QUOTE|引用] / [回复 "..."]` */
const stripQuotes = (t: string): string =>
  t
    .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')
    .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
    .replace(/\[回复\s*[""“][^""”]*?[""”](?:\.{0,3})\]\s*[：:]?\s*/g, '');

/** markdown 标题 `# heading` → `heading` (保留文字) */
const stripMarkdownHeaders = (t: string): string => t.replace(/^#{1,6}\s+/gm, '');

/** markdown 加粗 `**bold**` → `bold` (聊天里粗体没用, 直接吃掉星号) */
const stripMarkdownBold = (t: string): string => t.replace(/\*{2,}/g, '');

/** `---` / 空 bullet 行 */
const stripMarkdownDividers = (t: string): string =>
  t.replace(/^\s*---\s*$/gm, '').replace(/^\s*[-*+]\s*$/gm, '');

/** backtick: 保留 ``` `[[...]]` ``` 内部, 剥 ``` `` ``` 和单 backtick */
const stripBackticks = (t: string): string =>
  t
    .replace(/`(\[\[[\s\S]*?\]\])`/g, '$1')
    .replace(/``+/g, '')
    .replace(/(^|\s)`(\s|$)/gm, '$1$2');

/** `%%TRANS%%...` 老翻译标记 (保留 `%%BILINGUAL%%` 跟 `<翻译>` XML) */
const stripLegacyTrans = (t: string): string => t.replace(/%%TRANS%%[\s\S]*/gi, '');

/** `\n{3,}` → `\n\n` + trim */
const collapseWhitespace = (t: string): string => t.replace(/\n{3,}/g, '\n\n').trim();

// ─── notification 专用 helper ──────────────────────────────────────────────

/** `<think|thinking|thought>...</...>` 整块, 含未闭合兜底 */
const stripThinkBlocks = (t: string): string =>
  t
    .replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');

/** `[[INNER_STATE:...]]` */
const stripInnerState = (t: string): string => t.replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '');

/** `[text](url)` → `[链接：text]` (全角冒号) */
const replaceMarkdownLinks = (t: string): string =>
  t.replace(/\[([^\]]+)\]\([^)]+\)/g, '[链接：$1]');

/** `[[SEND_EMOJI: 名称]]` → `[表情：名称]` */
const replaceSendEmoji = (t: string): string =>
  t.replace(/\[\[SEND_EMOJI:\s*(.+?)\]\]/g, '[表情：$1]');

/** `[xxx 发送了表情包: 名称]` → `[表情：名称]` (直接转最终展示, 跳过 SEND_EMOJI 中间形态) */
const replaceEmojiReverseTag = (t: string): string =>
  t.replace(/\[(?:你|User|用户|System|[\w一-龥]+)\s*发送了表情包[:：]\s*(.*?)\]/g, '[表情：$1]');

/** `[html]...[/html]` → `[HTML 卡片]` */
const replaceHtmlBlocks = (t: string): string =>
  t.replace(/\[html\][\s\S]*?\[\/html\]/gi, '[HTML 卡片]');

/** `<翻译><原文>X</原文><译文>Y</译文></翻译>` → `X` (只保留原文剥光译文块) */
const extractTranslationOriginal = (t: string): string =>
  t.replace(
    /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g,
    '$1',
  );

// ─── facade 高层 API ───────────────────────────────────────────────────────

/**
 * worker push notification.body 终态处理:
 *  - 剥光 <think> / INNER_STATE / 业务标签 / 引用 / 时间戳 / 历史 leak
 *  - 替换 SEND_EMOJI / [html] / [text](url) 为可读 placeholder
 *  - <翻译> 只保留原文
 *
 * 顺序很重要 — 见处理顺序注释.
 */
export function sanitizeForNotification(text: string): string {
  let result = text;
  // 1. 字面 \n 还原 — 否则后续 ^ 锚定失效
  result = stripLiteralBackslashN(result);
  // 2. think 块最早剥 — 里面可能含其他 tag 影响后续匹配
  result = stripThinkBlocks(result);
  // 3. HTML 块替换 — 内部 markdown/tag 不应被处理
  result = replaceHtmlBlocks(result);
  // 4. 反向 emoji tag 先于正向 SEND_EMOJI (反向可能也走 SEND_EMOJI 重写, 但这里直接转最终展示)
  result = replaceEmojiReverseTag(result);
  result = replaceSendEmoji(result);
  // 5. 翻译块保留原文剥译文
  result = extractTranslationOriginal(result);
  // 6. LLM mimicking 历史的 leak: 时间戳 / 日期 / 角色名 prefix
  result = stripTimestamps(result);
  result = stripChineseDate(result);
  result = stripRoleNamePrefix(result);
  // 7. 源标签 [聊天] 等
  result = stripSourceTags(result);
  // 8. 内部状态 / 业务标签 / 引用
  result = stripInnerState(result);
  result = stripBusinessTagsForNotification(result);
  result = stripQuotes(result);
  // 9. 链接 → [链接：text] (必须先于 markdown header/bold strip, 避免 [text](url) 内的 # 被误剥)
  result = replaceMarkdownLinks(result);
  // 10. markdown 修饰
  result = stripMarkdownHeaders(result);
  result = stripMarkdownBold(result);
  result = stripMarkdownDividers(result);
  // 11. backtick
  result = stripBackticks(result);
  // 12. 老翻译标记
  result = stripLegacyTrans(result);
  // 13. 空白收尾
  result = collapseWhitespace(result);
  return result;
}

/**
 * chatParser.sanitize 实现 — 客户端 13 步管线**预处理**.
 *
 * 跟 sanitizeForNotification 的差异:
 *  - 保留 SEND_EMOJI / [html] / <翻译> / <think> / [[INNER_STATE:...]] (后续 step 接管)
 *  - 保留 markdown 链接 text(url) (chatParser 老行为是只剥 url 留 text, 这里也保持一致)
 *  - keepCitations 选项控制 `[[QUOTE|引用]]` 是否保留 (chunking 用)
 */
export function sanitizeForBubble(
  text: string,
  options?: { keepCitations?: boolean },
): string {
  let result = text;
  // 1. 字面 \n 还原
  result = stripLiteralBackslashN(result);
  // 2. 源标签 / 时间戳 / 业务标签
  result = stripSourceTags(result);
  result = stripTimestamps(result);
  result = stripMarkdownHeaders(result);
  result = stripBusinessTagsForBubble(result);
  if (!options?.keepCitations) {
    result = stripQuotes(result);
  }
  // 3. backtick / markdown link (chatParser 老行为: 剥 url 留 text)
  result = stripBackticks(result);
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // 4. markdown bold / dividers
  result = stripMarkdownBold(result);
  result = stripMarkdownDividers(result);
  // 5. 老翻译标记
  result = stripLegacyTrans(result);
  // 6. 收尾
  result = collapseWhitespace(result);
  return result;
}

// ─── Segments API (amsg-instant 0.8.0-next.4+ pushPayloads) ────────────────

/**
 * 一段内容 → 一条 push.
 *  - `raw`: 给客户端 `message` 字段, 保留 SEND_EMOJI / [html] 等业务标签让
 *           applyAssistantPostProcessing Step 5/8/9 正确渲染气泡 (sticker / HTML 卡)
 *  - `sanitized`: 给 `notification.body`, OS banner 显示用的可读 placeholder
 *
 * 两个字段在大多数 chunk 上是一样的 (普通文本); 只有原子单元 (SEND_EMOJI / [html])
 * 时两者才分叉.
 */
export interface Segment {
  raw: string;
  sanitized: string;
}

/**
 * worker push notification + bubble 共用的分段器.
 *
 * 算法:
 *  1. Phase 1 — 全文 strip suppress content (think 块 / INNER_STATE / 业务标签 /
 *     时间戳 leak / 引用 / source tag / 历史 leak / divider / 老 trans). 必须先全文
 *     跑, 因为 think 跨多行, 单行 chunk 看不到完整块.
 *  2. Phase 2 — chunkText: 按 `\n` 切 + 按 CJK 字符之间的空格切, 跟客户端
 *     `chatParser.chunkText` 字节对齐 (LLM 在 prompt 引导下用换行断句).
 *  3. Phase 3 — 每个 chunk 内拆 SEND_EMOJI 独立成段, 文字段跑 banner-only 替换
 *     (markdown link / [html] / markdown header/bold/backtick).
 *
 * 不切句号 — 客户端 chunkText 也不切, 保持气泡数 == banner 数.
 *
 * 返回空数组的情况: LLM 整段输出 sanitize 完只剩 think / 业务标签 / 空白 — 此时
 * 不发任何 banner / bubble (skip-push 语义).
 */
export function sanitizeIntoSegments(text: string): Segment[] {
  // Phase 1: 全文 suppress
  let cleaned = stripLiteralBackslashN(text);
  cleaned = stripThinkBlocks(cleaned);
  cleaned = extractTranslationOriginal(cleaned);
  cleaned = stripInnerState(cleaned);
  cleaned = stripBusinessTagsForNotification(cleaned);
  cleaned = stripTimestamps(cleaned);
  cleaned = stripChineseDate(cleaned);
  cleaned = stripRoleNamePrefix(cleaned);
  cleaned = stripSourceTags(cleaned);
  cleaned = stripQuotes(cleaned);
  cleaned = stripLegacyTrans(cleaned);
  cleaned = stripMarkdownDividers(cleaned);

  // Phase 2: chunk 跟客户端 chatParser.chunkText 同算法 (内联避免 import chatParser
  // 把 DB / React / Capacitor 依赖拖进 worker bundle)
  const rawChunks = chunkText(cleaned);

  // Phase 3: 拆 SEND_EMOJI + banner-only 替换
  const segments: Segment[] = [];
  for (const rawChunk of rawChunks) {
    const parts = splitOnSendEmoji(rawChunk);
    for (const part of parts) {
      if (part.kind === 'emoji') {
        segments.push({
          raw: `[[SEND_EMOJI: ${part.name}]]`,
          sanitized: `[表情：${part.name}]`,
        });
        continue;
      }
      const rawText = part.text.trim();
      if (!rawText) continue;
      const sanitized = sanitizeTextForBanner(rawText).trim();
      if (!sanitized) continue;
      segments.push({ raw: rawText, sanitized });
    }
  }
  return segments;
}

/**
 * 单个文字 chunk 的 banner-side 替换. 不动 raw 文字, 只产 sanitized 版本.
 * SEND_EMOJI 已经在 splitOnSendEmoji 阶段独立成段, 这里不处理.
 */
function sanitizeTextForBanner(text: string): string {
  let result = text;
  result = replaceHtmlBlocks(result);       // [html]...[/html] → [HTML 卡片] (chunk 内 inline)
  result = replaceEmojiReverseTag(result);  // [xxx 发送了表情包: yyy] → [表情：yyy]
  result = replaceMarkdownLinks(result);    // [text](url) → [链接：text]
  result = stripMarkdownHeaders(result);
  result = stripMarkdownBold(result);
  result = stripBackticks(result);
  result = collapseWhitespace(result);
  return result;
}

/**
 * `chatParser.chunkText` 的无依赖版本. 行为字节对齐:
 *  1. 按换行符切 (\n / \r\n / \r /   /  )
 *  2. 每个 chunk 再按 CJK 字符之间的空格切 (中文里本不该有空格 = LLM 想断行)
 *  3. trim + filter empty
 */
function chunkText(text: string): string[] {
  const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3000-\\u303f\\uff00-\\uffef\\u2000-\\u206f\\u2e80-\\u2eff\\u3001-\\u3003\\u2018-\\u201f\\u300a-\\u300f\\uff01-\\uff0f\\uff1a-\\uff20';
  const cjkSpaceRe = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`);

  const lineChunks = text.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const out: string[] = [];
  for (const chunk of lineChunks) {
    const sub = chunk.split(cjkSpaceRe)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    out.push(...sub);
  }
  return out;
}

/**
 * 把 chunk 里的 `[[SEND_EMOJI: 名称]]` 拆出来当独立 part. 跟客户端
 * `chatParser.splitResponse` 行为对齐 (输出 shape 不同, 这里用 kind 字段区分).
 */
function splitOnSendEmoji(chunk: string): Array<
  | { kind: 'text'; text: string }
  | { kind: 'emoji'; name: string }
> {
  const re = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'emoji'; name: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: 'text', text: chunk.slice(lastIndex, m.index) });
    }
    parts.push({ kind: 'emoji', name: m[1].trim() });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < chunk.length) {
    parts.push({ kind: 'text', text: chunk.slice(lastIndex) });
  }
  if (parts.length === 0 && chunk) parts.push({ kind: 'text', text: chunk });
  return parts;
}
