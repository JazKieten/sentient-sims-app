import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import {
  PatreonService,
  patreonLinkExpiredMessage,
  patreonLinkFailedMessage,
} from 'main/sentient-sims/services/PatreonService';
import { mockApiContext } from './util';

const popups: (string | undefined)[] = [];

// Hoisted above the imports; the popup closure reads `popups` only when called
vi.mock('main/sentient-sims/util/notifyRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('main/sentient-sims/util/notifyRenderer')>();
  return {
    ...actual,
    notifyPatreonLinking: vi.fn(),
    notifyRefreshAuth: vi.fn(),
    sendPopUpNotification: (message?: string) => {
      popups.push(message);
    },
  };
});

function fakeJwt(expDeltaSeconds: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expDeltaSeconds })}.sig`;
}

describe('PatreonService link', () => {
  const ctx = mockApiContext({ port: 25197 });
  let stub: http.Server;
  const acceptedTokens = new Set<string>();
  let onUnauthorized: (() => void) | undefined;
  let failBody: string | undefined;
  let requests = 0;

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      requests += 1;
      res.setHeader('Content-Type', 'application/json');
      if (!acceptedTokens.has(req.headers.authentication as string)) {
        onUnauthorized?.();
        res.statusCode = 401;
        res.end('{"message":"token has invalid claims: token is expired","code":401}');
        return;
      }
      if (failBody) {
        res.statusCode = 400;
        res.end(failBody);
        return;
      }
      res.end('{"message":"Updated."}');
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const { port } = stub.address() as AddressInfo;
    ctx.settings.sentientSimsAIEndpoint = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stub.close(() => {
        resolve();
      });
    });
  });

  function reset(token: string) {
    acceptedTokens.clear();
    popups.length = 0;
    requests = 0;
    onUnauthorized = undefined;
    failBody = undefined;
    ctx.settings.accessToken = token;
  }

  it('waits for a renewed token before sending when the stored token is expired', async () => {
    const fresh = fakeJwt(3600);
    reset(fakeJwt(-3600));
    acceptedTokens.add(fresh);
    setTimeout(() => {
      ctx.settings.accessToken = fresh;
    }, 300);

    await new PatreonService(ctx).handlePatreonRedirect('code');

    expect(requests).toEqual(1);
    expect(popups).toEqual([]);
  }, 30000);

  it('retries once when the server rejects a token that gets renewed', async () => {
    const renewed = fakeJwt(7200);
    reset(fakeJwt(3600));
    acceptedTokens.add(renewed);
    onUnauthorized = () => {
      ctx.settings.accessToken = renewed;
    };

    await new PatreonService(ctx).handlePatreonRedirect('code');

    expect(requests).toEqual(2);
    expect(popups).toEqual([]);
  }, 30000);

  it('tells the player to sign in again instead of showing the server reply', async () => {
    reset(fakeJwt(3600));

    await expect(new PatreonService(ctx).handlePatreonRedirect('code')).rejects.toThrow();

    expect(popups).toEqual([patreonLinkExpiredMessage]);
  }, 30000);

  it('shows a plain retry message for any other failure', async () => {
    const token = fakeJwt(3600);
    reset(token);
    acceptedTokens.add(token);
    failBody = '{"message":"invalid_grant","code":400}';

    await expect(new PatreonService(ctx).handlePatreonRedirect('code')).rejects.toThrow();

    expect(popups).toEqual([patreonLinkFailedMessage]);
  }, 30000);
});
