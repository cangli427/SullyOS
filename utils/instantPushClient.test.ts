import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendInstantPush, saveInstantConfig, INSTANT_PUSH_CONFIG_KEY } from './instantPushClient';
import type { InstantPushPayload } from './instantPushClient';
import { savePushVapid } from './pushVapid';

// 测 splitPattern 注入到 request body 外层 — 这是 amsg-instant 0.8.0-next.2
// 用来禁默认按句切的唯一正确位置 (放 hook 返回的 pushPayload 上是 no-op).

function setupValidConfig(): void {
  // pushVapid: vapidPublicKey.length 必须 > 60
  savePushVapid({
    vapidPublicKey: 'BIfakeVapidKeyForTestingMustBeOver60CharactersLongAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    vapidPrivateKey: 'private-stub',
  });
  saveInstantConfig({
    enabled: true,
    workerUrl: 'https://worker.example.com',
  });
}

function clearConfig(): void {
  try {
    localStorage.removeItem(INSTANT_PUSH_CONFIG_KEY);
    localStorage.removeItem('push_vapid_v1');
  } catch {}
}

function basePayload(): InstantPushPayload {
  return {
    contactName: 'TestChar',
    apiUrl: 'https://api.example.com',
    apiKey: 'k',
    primaryModel: 'm',
    pushSubscription: {
      endpoint: 'https://push.example.com/e',
      keys: { p256dh: 'p', auth: 'a' },
    },
    completePrompt: 'hi',
  };
}

describe('sendInstantPush splitPattern injection', () => {
  beforeEach(() => {
    clearConfig();
    setupValidConfig();
    // 替换全局 fetch 抓 body
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map([['cf-ray', 'test']]) as any,
      text: async () => '{"success":true}',
    } as any);
  });

  it('next.4 不再注入 splitPattern, payload 直接 stringify', async () => {
    await sendInstantPush(basePayload());
    expect(fetch).toHaveBeenCalled();
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const init = callArgs[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // amsg-instant 0.8.0-next.4 起 splitPattern 字段被服务端拒收, 客户端也不再带
    expect(body.splitPattern).toBeUndefined();
  });

  it('其他字段不受影响 (verify payload 形状没改)', async () => {
    await sendInstantPush(basePayload());
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.contactName).toBe('TestChar');
    expect(body.apiUrl).toBe('https://api.example.com');
    expect(body.completePrompt).toBe('hi');
    expect(body.pushSubscription).toEqual({
      endpoint: 'https://push.example.com/e',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });
});
