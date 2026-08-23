import { LineProtocolService } from '../line/core/service.js';
import { handleListConversations } from '../mcp/handlers/conversations.js';
import { resolveConversationNames, resolveSenderNames } from '../mcp/names.js';
import { decryptLineMessage } from '../line/core/message-query-service.js';
import { sanitizeMessagePreview } from '../line/core/message-preview.js';
import { interpretFlexMessage } from '../line/core/flex-message.js';
import { chatEventParticipantMids, interpretChatEvent } from '../line/core/chat-event.js';
import {
  fetchStickerImage,
  fetchStickerPackageMetaCached,
  localizedStickerTitle,
} from '../line/client/sticker-meta.js';
import { scoreAttentionBatch, AttentionTier } from '../attention/policy.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliConversationJsonItem {
  id: string;
  title: string;
  lastMessage: string;
  timeString: string;
  timestamp: number;
  unreadCount: number;
  isMuted: boolean;
  isGroup: boolean;
  hasMention: boolean;
  pictureUrl: string | null;
  isOfficial?: boolean;
  attentionScore: number;
  attentionTier: AttentionTier;
  attentionReason: string;
}

type AttentionCacheEntry = { score: number; tier: AttentionTier; reason: string; updatedAt: number };
type AttentionCache = Record<string, AttentionCacheEntry>;
const attentionCachePath = join(process.env.YOMI_DATA_DIR || join(homedir(), '.yomi'), 'attention-cache.json');
const ATTENTION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ATTENTION_CACHE_MAX_ENTRIES = 1000;
const ATTENTION_BATCH_SIZE = 8;
const ATTENTION_POLICY_VERSION = 2;

function attentionSignature(item: Pick<CliConversationJsonItem, 'id' | 'lastMessage' | 'isOfficial' | 'isMuted'>): string {
  return createHash('sha256').update(JSON.stringify([ATTENTION_POLICY_VERSION, item.id, item.lastMessage, item.isOfficial, item.isMuted])).digest('hex');
}

async function loadAttentionCache(): Promise<AttentionCache> {
  try {
    const cache = JSON.parse(await readFile(attentionCachePath, 'utf8')) as AttentionCache;
    const cutoff = Date.now() - ATTENTION_CACHE_TTL_MS;
    return Object.fromEntries(Object.entries(cache).filter(([, entry]) => (entry.updatedAt || 0) >= cutoff));
  } catch { return {}; }
}

async function saveAttentionCache(cache: AttentionCache): Promise<void> {
  const bounded = Object.fromEntries(
    Object.entries(cache).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, ATTENTION_CACHE_MAX_ENTRIES),
  );
  await mkdir(dirname(attentionCachePath), { recursive: true });
  await writeFile(attentionCachePath, JSON.stringify(bounded), { mode: 0o600 });
}

export async function cliClassifyAttentionJson(items: CliConversationJsonItem[]): Promise<Array<{ id: string; attentionScore: number; attentionTier: AttentionTier; attentionReason: string }>> {
  const cache = await loadAttentionCache();
  const batch = items.slice(0, ATTENTION_BATCH_SIZE);
  if (batch.length === 0) return [];
  const evaluations = await scoreAttentionBatch(batch.map(item => ({
    id: item.id, text: item.lastMessage, unreadCount: 0, isMuted: item.isMuted,
    isOfficial: item.isOfficial, hasMention: item.hasMention,
  })));
  const results = batch.map((item, index) => {
    const result = evaluations[index];
    cache[attentionSignature(item)] = { ...result, updatedAt: Date.now() };
    return {
      id: item.id,
      attentionScore: result.score + (item.unreadCount > 0 ? 5 : 0),
      attentionTier: result.tier,
      attentionReason: result.reason,
    };
  });
  await saveAttentionCache(cache);
  return results;
}

export interface CliChatMessageJsonItem {
  id: string;
  fromMid: string;
  fromName: string;
  fromPictureUrl: string | null;
  isSelf: boolean;
  text: string;
  timeString: string;
  timestamp: number;
  contentType: number;
  mediaType: string | null;
  mediaUrl: string | null;
  actionUrl?: string | null;
  fileName: string | null;
}

export interface CliStickerPreviewJson {
  stickerId: string;
  packageId: string;
  data: string;
  mimeType: string;
}

/** Read-only bridge for the desktop sticker picker. */
export async function cliListStickersJson(language = 'zh_TW'): Promise<any[]> {
  const service = new LineProtocolService();
  if (!(await service.resumeSession())) return [];
  const owned = await service.listStickerPackages(language);
  return Promise.all(owned.map(async (pkg: any) => {
    const packageId = String(pkg.packageId ?? '');
    if (!packageId) return pkg;
    const meta = await fetchStickerPackageMetaCached(packageId);
    return {
      ...pkg,
      title: localizedStickerTitle(meta?.title, language, String(pkg.title ?? '')),
    };
  }));
}

/** Read-only bridge for owned sticker previews; never sends a message. */
export async function cliStickerPreviewsJson(
  packageId: string,
  limit = 12,
  language = 'en',
): Promise<CliStickerPreviewJson[]> {
  if (!packageId) return [];
  const service = new LineProtocolService();
  if (!(await service.resumeSession())) return [];
  // The package must be owned before the public CDN metadata is expanded.
  const owned = await service.listStickerPackages(language);
  if (!owned.some((item: any) => String(item.packageId) === packageId)) return [];
  const meta = await fetchStickerPackageMetaCached(packageId);
  if (!meta) return [];
  const result: CliStickerPreviewJson[] = [];
  for (const stickerId of meta.stickerIds.slice(0, Math.max(1, limit))) {
    const bytes = await fetchStickerImage(stickerId);
    if (!bytes) continue;
    result.push({
      stickerId,
      packageId,
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    });
  }
  return result;
}

function parseMediaText(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Only expose web URLs from LINE rich-message metadata. */
function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function firstWebLink(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstWebLink(item)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  for (const [key, item] of Object.entries(record)) {
    if (key === 'linkUri') {
      const found = safeWebUrl(item)
      if (found) return found
    }
    const nested = firstWebLink(item)
    if (nested) return nested
  }
  return null
}

export function richFields(message: any): { altText: string; mediaUrl: string | null; actionUrl: string | null } {
  const metadata = message?.contentMetadata && typeof message.contentMetadata === 'object'
    ? message.contentMetadata as Record<string, unknown>
    : {}
  const interpreted = interpretFlexMessage(message)
  const explicitAlt = sanitizeMessagePreview(metadata.ALT_TEXT) || ''
  const altText = interpreted.summary || explicitAlt
  const mediaUrl = safeWebUrl(metadata.DOWNLOAD_URL) || interpreted.imageUrl
  const redirect = safeWebUrl(metadata.LINE_TAG_REDIRECTOR)
  let markup: unknown = metadata.MARKUP_JSON
  if (typeof markup === 'string') {
    try { markup = JSON.parse(markup) } catch { markup = null }
  }
  return { altText, mediaUrl, actionUrl: redirect || interpreted.actionUrl || firstWebLink(markup) }
}

export { sanitizeMessagePreview } from '../line/core/message-preview.js';

export function messagePlaceholder(contentType: number, hasOpaquePayload = false): string {
  switch (contentType) {
    case 0: return hasOpaquePayload ? '[加密訊息]' : '[訊息]'
    case 7: return '[貼圖]'
    case 4: return '[網頁內容]'
    case 5: return '[PDF 文件]'
    case 6: return '[通話紀錄]'
    case 8: return '[動態狀態]'
    case 9: return '[禮物]'
    case 10: return '[群組記事本]'
    case 11: return '[應用程式連結]'
    case 12: return '[分享連結]'
    case 13: return '[聯絡人]'
    case 15: return '[位置資訊]'
    case 16: return '[貼文通知]'
    case 17: return '[互動卡片]'
    case 18: return '[聊天室活動]'
    case 19: return '[音樂]'
    case 20: return '[付款資訊]'
    case 21: return '[延伸圖片]'
    case 22: return '[互動卡片]'
    case 1: return '[圖片]'
    case 2: return '[影片]'
    case 3: return '[語音訊息]'
    case 14: return '[檔案]'
    default: return hasOpaquePayload ? '[加密訊息]' : `[LINE 內容 ${contentType}]`
  }
}

function isRichContentType(contentType: number): boolean {
  return contentType === 17 || contentType === 22
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return '';
  const date = new Date(Number(timestamp));
  const now = new Date();
  
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');

  if (isToday) {
    return `${hours}:${minutes}`;
  }
  if (isYesterday) {
    return '昨天';
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function messageTimestamp(message: any): number {
  return Number(message?.deliveredTime || message?.createdTime || 0)
}

function latestMessage(messages: any[] | undefined): any | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  return messages.reduce((latest, candidate) =>
    messageTimestamp(candidate) >= messageTimestamp(latest) ? candidate : latest,
  )
}

export async function cliListConversationsJson(args: { limit?: number; attentionOnly?: boolean; firstPage?: boolean; semantic?: boolean } = {}): Promise<CliConversationJsonItem[]> {
  const service = new LineProtocolService();
  const ok = await service.resumeSession();
  if (!ok) return [];

  try {
    // Advance the Talk revision before reading message boxes. A fresh client
    // process starts with no checkpoint; syncLongPoll now obtains the server's
    // last-op revision before issuing sync, then we persist the monotonic
    // checkpoint through the session-state owner for the next bridge process.
    try {
      await service.client.syncLongPoll(50, 1000);
      if (service.sessionState?.setRevisions) {
        await service.sessionState.setRevisions(
          Number(service.client.revision || 0),
          Number(service.client.globalRevision || 0),
          Number(service.client.individualRevision || 0),
        );
      }
    } catch {}
    const result = args.firstPage
      ? await service.client.getMessageBoxes({
        lastMessagesPerMessageBoxCount: 1,
        messageBoxCountLimit: args.limit ?? 100,
        withUnreadCount: true,
      })
      : await service.client.getAllMessageBoxes({
      lastMessagesPerMessageBoxCount: 1,
      ...(args.limit ? { messageBoxCountLimit: args.limit } : {}),
      withUnreadCount: true,
    });
    const boxes = result.messageBoxes || [];
    const chatIds = boxes.map((box: any) => box.id).filter(Boolean);
    const names = await resolveConversationNames(service, chatIds);

    // Resolve contacts picture paths
    const userMids = chatIds.filter((id: string) => id.startsWith('u'));
    const contactMap = new Map<string, any>();
    if (userMids.length > 0) {
      try {
        const contacts = await service.client.getContacts(userMids);
        for (const c of contacts || []) {
          if (c?.mid) contactMap.set(c.mid, c);
        }
      } catch {}
    }

    const conversations = await Promise.all(
      boxes.map(async (box: any) => {
        let lastMsg = latestMessage(box.lastMessages);
        const boxDeliveredTime = Number(box.lastDeliveredMessageId?.deliveredTime || 0);
        // Some LINE responses return a lastMessages array that lags the
        // last-delivered cursor. Fetch one message only for that box so the
        // inbox preview and date cannot remain days behind.
        if (box.id && (!lastMsg || messageTimestamp(lastMsg) < boxDeliveredTime)) {
          try {
            const recent = await service.getRecentMessages(box.id, 1);
            const candidate = latestMessage(recent);
            if (candidate && messageTimestamp(candidate) >= messageTimestamp(lastMsg)) {
              lastMsg = candidate;
            }
          } catch {}
        }
        let preview = '(無訊息)';
        let timestamp = 0;

        if (lastMsg) {
          timestamp = messageTimestamp(lastMsg);
          const rich = isRichContentType(Number(lastMsg.contentType)) ? richFields(lastMsg) : null;
          const rawPreview = rich?.altText || sanitizeMessagePreview(lastMsg.text);
          if (rawPreview) {
            preview = rawPreview;
          } else {
            const decrypted = await decryptLineMessage(service.e2eeManager, lastMsg, box.id);
            const decryptedPreview = sanitizeMessagePreview(decrypted?.text);
            if (decryptedPreview) preview = decryptedPreview;
            else if (lastMsg.contentType) preview = messagePlaceholder(Number(lastMsg.contentType));
            else if (lastMsg.text) preview = messagePlaceholder(0, true);
          }
        }

        const isGroup = box.id?.startsWith('c') || box.id?.startsWith('r');
        const defaultTitle = isGroup ? '群組對話' : '好友對話';
        const title = names.get(box.id) || defaultTitle;
        const chatCached = service.chatCache.get(box.id);
        const contact = contactMap.get(box.id);

        let picPath: string | null = null;
        if (isGroup && chatCached?.picturePath) {
          picPath = chatCached.picturePath;
        } else if (!isGroup && contact?.picturePath) {
          picPath = contact.picturePath;
        }

        const pictureUrl = picPath ? `https://obs.line-scdn.net/${picPath.replace(/^\/+/, '')}` : null;
        const isMuted = isGroup
          ? Boolean(chatCached?.notificationDisabled)
          : Boolean(contact?.notificationDisabled ?? chatCached?.notificationDisabled);
        const unreadCount = box.unreadCount ?? 0;

        return {
          id: box.id,
          title,
          lastMessage: preview.replace(/\n+/g, ' ').trim(),
          timeString: formatTimestamp(timestamp),
          timestamp,
          unreadCount,
          isMuted,
          isGroup,
          hasMention: false,
          pictureUrl,
          isOfficial: Boolean(contact?.isOfficial),
          attentionScore: 0,
          attentionTier: 'filtered' as AttentionTier,
          attentionReason: '正在整理新訊息…',
        };
      })
    );

    const cache = await loadAttentionCache();
    const pending: number[] = [];
    conversations.forEach((conversation, index) => {
      const cached = cache[attentionSignature(conversation)];
      if (cached) {
        conversation.attentionScore = cached.score + (conversation.unreadCount > 0 ? 5 : 0);
        conversation.attentionTier = cached.tier;
        conversation.attentionReason = cached.reason;
      } else if (conversation.isMuted || conversation.unreadCount === 0) {
        conversation.attentionScore = conversation.isMuted ? -100 : 0;
        conversation.attentionTier = 'filtered';
        conversation.attentionReason = conversation.isMuted ? '已靜音' : '已讀，等待需要時分析';
      } else {
        pending.push(index);
        // Fast first paint: uncached unread messages stay visible until the
        // background semantic pass refines them. No model loads on this path.
        conversation.attentionScore = conversation.isOfficial ? 0 : 20;
        conversation.attentionTier = conversation.isOfficial ? 'filtered' : 'know';
        conversation.attentionReason = '正在整理新訊息…';
      }
    });

    if (args.semantic && pending.length > 0) {
      try {
        const evaluations = await scoreAttentionBatch(pending.map(index => {
          const conversation = conversations[index];
          return { id: conversation.id, text: conversation.lastMessage, unreadCount: 0, isMuted: conversation.isMuted, isOfficial: conversation.isOfficial, hasMention: conversation.hasMention };
        }));
        pending.forEach((conversationIndex, resultIndex) => {
          const conversation = conversations[conversationIndex];
          const result = evaluations[resultIndex];
          cache[attentionSignature(conversation)] = { ...result, updatedAt: Date.now() };
          conversation.attentionScore = result.score + (conversation.unreadCount > 0 ? 5 : 0);
          conversation.attentionTier = result.tier;
          conversation.attentionReason = result.reason;
        });
        await saveAttentionCache(cache);
      } catch {
        pending.forEach(index => { conversations[index].attentionReason = '暫時無法判斷重要性，稍後再試'; });
      }
    }

    // Sort by timestamp descending
    conversations.sort((a, b) => b.timestamp - a.timestamp);

    if (args.attentionOnly) {
      return conversations.filter(c => c.attentionTier !== 'filtered');
    }

    return conversations;
  } catch (err) {
    return [];
  }
}

export async function cliGetChatMessagesJson(chatId: string, count = 30): Promise<CliChatMessageJsonItem[]> {
  const service = new LineProtocolService();
  const ok = await service.resumeSession();
  if (!ok) return [];

  try {
    // Always use the service-owned query boundary here. It opportunistically
    // decrypts E2EE envelopes; reading service.client directly leaves media
    // messages with contentType=0 and opaque text, which makes image/file
    // rendering look empty even though LINE returned the message.
    const rawMessages = await service.getRecentMessages(chatId, count);
    const mids = Array.from(new Set(rawMessages.flatMap((message: any) => [message.from, ...chatEventParticipantMids(message)]).filter(Boolean)));
    const names = await resolveSenderNames(service, mids);

    const userMids = Array.from(new Set(mids.filter((m: string) => m.startsWith('u'))));
    const contactMap = new Map<string, any>();
    if (userMids.length > 0) {
      try {
        const contacts = await service.client.getContacts(userMids);
        for (const c of contacts || []) {
          if (c?.mid) contactMap.set(c.mid, c);
        }
      } catch {}
    }

    const selfMid = service.profile?.mid;
    const selfName = service.profile?.displayName || '我';
    const selfPicPath = service.profile?.picturePath;
    const selfPicUrl = selfPicPath ? `https://obs.line-scdn.net/${selfPicPath.replace(/^\/+/, '')}` : null;

    const formatted: CliChatMessageJsonItem[] = rawMessages.map((m: any) => {
      const isSelf = m.from === selfMid;
      const fromName = isSelf ? selfName : (names.get(m.from) || '成員');
      const contact = contactMap.get(m.from);
      const picPath = isSelf ? selfPicPath : contact?.picturePath;
      const fromPictureUrl = isSelf ? selfPicUrl : (picPath ? `https://obs.line-scdn.net/${picPath.replace(/^\/+/, '')}` : null);

      const contentType = Number(m.contentType || 0);
      const metadata = m.contentMetadata || {};
      const mediaText = parseMediaText(m.text);
      const stickerId = metadata.STKID || metadata.stickerId;
      const rich = isRichContentType(contentType) ? richFields(m) : null;
      let text = sanitizeMessagePreview(m.text);
      if (contentType === 18) text = interpretChatEvent(m, names);
      if (rich?.altText) text = rich.altText;
      if (!text) {
        text = messagePlaceholder(contentType, Boolean(m.text));
      }

      const timestamp = Number(m.deliveredTime || m.createdTime || 0);

      return {
        id: String(m.id),
        fromMid: m.from || '',
        fromName,
        fromPictureUrl,
        isSelf,
        text,
        timeString: formatTimestamp(timestamp),
        timestamp,
        contentType,
        mediaType: ({
          1: 'image',
          2: 'video',
          3: 'audio',
          7: 'sticker',
          14: 'file',
          17: 'rich',
          22: 'rich',
        } as Record<number, string>)[contentType] || null,
        mediaUrl: rich?.mediaUrl || (stickerId
          ? `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/sticker.png`
          : null),
        actionUrl: rich?.actionUrl || null,
        fileName: (typeof mediaText.fileName === 'string' ? mediaText.fileName : null)
          || (typeof metadata.FILE_NAME === 'string' ? metadata.FILE_NAME : null)
          || (typeof metadata.FILE_NAME_ORIGINAL === 'string' ? metadata.FILE_NAME_ORIGINAL : null)
          || (typeof metadata.name === 'string' ? metadata.name : null),
      };
    });

    // Chronological order (oldest to newest) for chat bubble view
    formatted.sort((a, b) => a.timestamp - b.timestamp);
    return formatted;
  } catch (err) {
    return [];
  }
}

export async function cliMarkReadJson(chatId: string, messageId?: string): Promise<{ success: boolean; marked: boolean }> {
  const service = new LineProtocolService();
  const ok = await service.resumeSession();
  if (!ok) return { success: false, marked: false };

  try {
    const res = await service.markChatRead(chatId, messageId);
    return { success: true, marked: res.marked };
  } catch (err) {
    return { success: false, marked: false };
  }
}

export async function cliRecentSummary(): Promise<string> {
  const service = new LineProtocolService();
  const ok = await service.resumeSession();
  if (!ok) {
    return '【LINE 狀態】尚未連線或憑證已過期，請先於選單列重新登入。';
  }

  try {
    const result = await handleListConversations(service, { limit: 12 });
    const rawText = result.content?.[0]?.text || '';

    const name = service.profile?.displayName || 'LINE User';
    let output = `【LINE 即時訊息摘要 — ${name}】\n• 加密狀態：Letter-Sealing (E2EE) 已解密安全連線\n\n`;

    // Parse TOON format lines
    const lines = rawText.split('\n').filter(l => l.trim().length > 0);
    const chats: Array<{ name: string; unread: number; preview: string }> = [];

    for (const line of lines) {
      if (line.startsWith('[') || line.includes('{id,')) continue;
      // Format: id,lastMessagePreview,name,unreadCount
      // Note that preview might contain quotes or escaped newlines
      const trimmed = line.trim();
      const parts = trimmed.split(',');
      if (parts.length >= 4) {
        const unread = parseInt(parts[parts.length - 1], 10) || 0;
        const chatName = parts[parts.length - 2] || '聊天室';
        const previewRaw = parts.slice(1, parts.length - 2).join(',');
        const preview = previewRaw === 'null' ? '(無文字或貼圖/媒體)' : previewRaw.replace(/^"|"$/g, '').replace(/\\n/g, ' ');
        chats.push({ name: chatName, unread, preview });
      }
    }

    if (chats.length > 0) {
      chats.forEach((chat) => {
        const unreadBadge = chat.unread > 0 ? ` 🔴 **[未讀 ${chat.unread} 則]**` : '';
        output += `• **${chat.name}**${unreadBadge}\n  ↳ 「${chat.preview}」\n\n`;
      });
    } else {
      output += '目前沒有最近的聊天室紀錄。\n';
    }

    return output.trim();
  } catch (err: any) {
    return `查詢 LINE 訊息時發生錯誤：${err.message || String(err)}`;
  }
}
