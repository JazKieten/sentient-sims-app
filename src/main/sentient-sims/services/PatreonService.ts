import log from 'electron-log';
import { notifyPatreonLinking, sendPopUpNotification } from '../util/notifyRenderer';
import { hasDecodableToken, waitForFreshToken } from '../auth/freshToken';
import { ApiContext } from './ApiContext';

export class NotLoggedInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotLoggedInError';
  }
}

export const patreonLinkExpiredMessage =
  'Your sign-in timed out, so Patreon could not be linked. Close the Sentient Sims app, open it again and sign in, then press "Link my Patreon account" again.';

export const patreonLinkFailedMessage =
  'Patreon could not be linked. Press "Link my Patreon account" again and press Allow on Patreon. If it keeps failing, restart the app and try once more.';

type LinkAttempt = { status: number; body: string };

export class PatreonService {
  private ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  private async sendCode(code: string): Promise<LinkAttempt> {
    const url = `${this.ctx.settings.sentientSimsAIEndpoint}/patreon-redirect?code=${code}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authentication: this.ctx.settings.accessToken,
      },
    });
    return { status: response.status, body: await response.text() };
  }

  async handlePatreonRedirect(code: string) {
    notifyPatreonLinking(true);
    try {
      if (!this.ctx.settings.accessToken) {
        throw new NotLoggedInError('Unable to handle patreon redirect');
      }

      let attempt: LinkAttempt;
      try {
        await waitForFreshToken(this.ctx.settings);
        const tokenAtRequest = this.ctx.settings.accessToken;
        attempt = await this.sendCode(code);

        // An expired token fails the server's JWT check before the Patreon code is
        // exchanged, so the code is still good for one retry with a renewed token
        if (attempt.status === 401 && hasDecodableToken(tokenAtRequest)) {
          log.info('Patreon link rejected the token, refreshing and retrying once');
          await waitForFreshToken(this.ctx.settings, tokenAtRequest);
          if (this.ctx.settings.accessToken !== tokenAtRequest) {
            attempt = await this.sendCode(code);
          }
        }
      } catch (err) {
        log.error('Patreon redirect failed', err);
        sendPopUpNotification(patreonLinkFailedMessage);
        throw err;
      }

      log.info(`Patreon redirect result: ${attempt.status} ${attempt.body}`);
      if (attempt.body !== '{"message":"Updated."}') {
        sendPopUpNotification(attempt.status === 401 ? patreonLinkExpiredMessage : patreonLinkFailedMessage);
        throw new Error(attempt.body);
      }
    } finally {
      notifyPatreonLinking(false);
    }
  }
}
