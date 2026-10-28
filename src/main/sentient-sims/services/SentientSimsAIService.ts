import log from 'electron-log';
import { AxiosError, RawAxiosRequestHeaders } from 'axios';
import { axiosClient } from '../clients/AxiosClient';
import { VLLMAIService } from './VLLMAIService';
import { hasDecodableToken, waitForFreshToken } from '../auth/freshToken';
import { plainSentientSimsError, SIGN_IN_TIMED_OUT } from '../util/providerErrorWords';
import { ApiType } from '../models/ApiType';
import { sentientSimsAIDefaultImageModel } from '../constants';
import { ImageGenerationRequest, ImageGenerationResponse } from '../models/ImageGeneration';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import { SimsGenerateResponse } from '../models/SimsGenerateResponse';
import { ImageGenerationService } from './ImageGenerationService';
import { GenerationCallControl } from './GenerationService';
import { usageHeaders } from './UsageHeaders';

// The server cuts image generation off at 120 seconds; outlast that so its
// timeout response arrives instead of a client-side abort
const imageGenerationTimeoutMs = 130000;

// Hotkey clips are short, so a slow answer means the server is stuck
const transcriptionTimeoutMs = 30000;

// OpenAI-compatible response shape of the server's /v1/images/generations
type SentientSimsImageGenerationResponse = {
  created: number;
  data: { b64_json?: string; url?: string }[];
};

function isUnauthorized(err: unknown): boolean {
  return err instanceof AxiosError && err.response?.status === 401;
}

export class SentientSimsAIService extends VLLMAIService implements ImageGenerationService {
  serviceUrl(): string {
    return this.ctx.settings.sentientSimsAIEndpoint;
  }

  getAuthorizationHeaders(purpose?: string): RawAxiosRequestHeaders {
    return {
      Authentication: this.ctx.settings.accessToken,
      ...this.ctx.version.getVersionHeaders(),
      ...(purpose ? usageHeaders(this.ctx, purpose) : {}),
    };
  }

  getModel(): string {
    return this.ctx.settings.sentientSimsAIModel;
  }

  protected modelSettingsApiType(): ApiType {
    return ApiType.SentientSimsAI;
  }

  // Runs a request with a fresh token, refreshing and retrying once when the
  // server rejects a token that expired or was revoked mid-request
  private async withAuthRetry<T>(makeRequest: () => Promise<T>): Promise<T> {
    await waitForFreshToken(this.ctx.settings);
    const tokenAtRequest = this.ctx.settings.accessToken;
    try {
      return await makeRequest();
    } catch (err) {
      if (!isUnauthorized(err)) {
        throw err;
      }
      if (!hasDecodableToken(tokenAtRequest)) {
        throw new Error(SIGN_IN_TIMED_OUT, { cause: err });
      }
      log.info('Sentient Sims AI rejected the token mid-request, refreshing and retrying once');
      await waitForFreshToken(this.ctx.settings, tokenAtRequest);
      if (this.ctx.settings.accessToken === tokenAtRequest) {
        throw new Error(SIGN_IN_TIMED_OUT, { cause: err });
      }
      try {
        return await makeRequest();
      } catch (retryErr) {
        throw isUnauthorized(retryErr) ? new Error(SIGN_IN_TIMED_OUT, { cause: retryErr }) : retryErr;
      }
    }
  }

  async sentientSimsGenerate(
    request: OpenAICompatibleRequest,
    control?: GenerationCallControl,
  ): Promise<SimsGenerateResponse> {
    return this.withAuthRetry(() => super.sentientSimsGenerate(request, control));
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const model = request.model ?? sentientSimsAIDefaultImageModel;

    log.debug(`Sentient Sims AI image request: model=${model}`);

    const response = await this.withAuthRetry(() =>
      axiosClient<SentientSimsImageGenerationResponse>({
        url: '/v1/images/generations',
        method: 'POST',
        data: { model, prompt: request.prompt },
        baseURL: this.serviceUrl(),
        timeout: imageGenerationTimeoutMs,
        headers: this.getAuthorizationHeaders('image'),
      }),
    );

    const imageBase64 = await this.toImageBase64(response.data);
    if (!imageBase64) {
      log.error(`No image data returned from Sentient Sims AI:\n${JSON.stringify(response.data)}`);
      throw new Error('No image data returned from Sentient Sims AI');
    }

    return {
      imageBase64,
      model,
      apiType: ApiType.SentientSimsAI,
    };
  }

  // The server takes base64 JSON and picks its own speech-to-text model
  async transcribe(audio: Buffer, format: string, language?: string, prompt?: string): Promise<string> {
    const response = await this.withAuthRetry(() =>
      axiosClient<{ text: string }>({
        url: '/v1/audio/transcriptions',
        method: 'POST',
        data: {
          input_audio: { data: audio.toString('base64'), format },
          ...(language ? { language } : {}),
          ...(prompt ? { prompt } : {}),
        },
        baseURL: this.serviceUrl(),
        timeout: transcriptionTimeoutMs,
        headers: this.getAuthorizationHeaders('stt'),
      }),
    );

    return response.data.text;
  }

  // The server normally returns base64, but passes provider-hosted image URLs
  // through as-is; those get downloaded so callers always receive base64
  private async toImageBase64(response: SentientSimsImageGenerationResponse): Promise<string | undefined> {
    const image = response.data.at(0);
    if (image?.b64_json) {
      return image.b64_json;
    }
    if (image?.url) {
      const download = await axiosClient<ArrayBuffer>({
        url: image.url,
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      return Buffer.from(download.data).toString('base64');
    }
    return undefined;
  }

  async healthCheck() {
    await waitForFreshToken(this.ctx.settings);

    try {
      const response = await axiosClient<string>({
        url: '/health',
        timeout: 5000,
        responseType: 'text',
        baseURL: this.serviceUrl(),
        headers: this.getAuthorizationHeaders(),
      });
      return {
        status: response.data,
      };
    } catch (e) {
      log.error('Error checking Sentient Sims AI health', e);

      return {
        error: plainSentientSimsError(e instanceof Error ? e.message : String(e)),
      };
    }
  }
}
