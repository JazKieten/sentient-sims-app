import { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runApi } from 'main/sentient-sims/api';
import { SimDossier } from 'main/sentient-sims/models/SimDossier';
import { mockApiContext } from './util';

// The bench routes are DEV tier (release 4.5). Moved out of DossierRoute.test.ts, which
// keeps the core dossier route.
describe('bench routes', () => {
  const ctx = mockApiContext({ port: 25208 });
  const apiUrl = `http://localhost:${ctx.port}`;
  let server: Server;

  async function post(path: string, body: unknown) {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function dossier(simId: string): SimDossier {
    return { sim_id: simId, name: `Sim ${simId}`, age: 'ADULT' };
  }

  beforeAll(() => {
    server = runApi(ctx);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it('rejects a self-knowledge event with no environment before any generation', async () => {
    const readDossier = vi.spyOn(ctx.semanticMemory, 'readDossier').mockReturnValue(dossier('100'));
    const generate = vi.spyOn(ctx.ai, 'runDirectedGeneration');
    try {
      const { status, body } = await post('/bench/self-knowledge/100', {
        event: { sentient_sims: [{ sim_id: '100', name: 'Sim 100' }] },
      });
      expect(status).toBe(400);
      expect(String(body.error)).toContain('environment.location_id');
      expect(generate).not.toHaveBeenCalled();
    } finally {
      readDossier.mockRestore();
      generate.mockRestore();
    }
  });
});
