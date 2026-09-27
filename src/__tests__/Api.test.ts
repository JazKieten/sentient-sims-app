import { runApi } from 'main/sentient-sims/api';
import * as fs from 'fs';
import { Version } from 'main/sentient-sims/services/VersionService';
import { VersionClient } from 'main/sentient-sims/clients/VersionClient';
import { Server } from 'http';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { SettingsClient } from 'main/sentient-sims/clients/SettingsClient';
import { mockApiContext } from './util';

describe('Api', () => {
  const ctx = mockApiContext();
  const apiUrl = `http://localhost:${ctx.port}`;
  let server: Server;

  beforeAll(() => {
    server = runApi(ctx);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err: Error | undefined) => {
        if (err) {
          console.error('Error', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  it('version controller', async () => {
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    const expectedVersion: Version = { version: 'expectedversion' };
    fs.writeFileSync(ctx.directory.getModVersionFile(), JSON.stringify(expectedVersion));

    const versionClient = new VersionClient(apiUrl);
    const modVersion = await versionClient.getModVersion();
    console.log(modVersion.version);
    expect(modVersion.version).toEqual(expectedVersion.version);
  });

  it('test settings api', async () => {
    const settingsClient = new SettingsClient(apiUrl);
    await settingsClient.updateSetting(SettingsEnum.LOCALIZATION_ENABLED, true);
    const result = await settingsClient.getSetting(SettingsEnum.LOCALIZATION_ENABLED);
    expect(result.value).toBeTruthy();
  }, 30000);
});
