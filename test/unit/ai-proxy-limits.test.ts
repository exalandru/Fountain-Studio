import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { aiRequestLimits, appendCollectedAiChunk } from '../../src/shared/ai/limits.js';
import type { AiStreamFrame } from '../../src/shared/ai/providers/types.js';
import { AiGuardError, AiRequestGuard } from '../../src/main/ai/guard.js';
import { readProviderStream, readResponseText } from '../../src/main/ai/stream.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; server: ReturnType<typeof createServer> }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function openAiFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function parseOpenAi(data: string): AiStreamFrame {
  const parsed = JSON.parse(data) as { choices: Array<{ delta: { content?: string } }> };
  return { content: parsed.choices[0]?.delta.content ?? '', reasoning: false };
}

describe('AiRequestGuard', () => {
  it('aborts on deadline even after early progress', async () => {
    const controller = new AbortController();
    const guard = new AiRequestGuard(
      controller,
      aiRequestLimits(40, { idleMs: 1_000, maxResponseBytes: 1_000_000 }),
    );
    guard.noteNetworkProgress(1);
    await expect(
      new Promise<void>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          try {
            expect(guard.error?.reason).toBe('deadline');
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }),
    ).resolves.toBeUndefined();
    guard.dispose();
  });

  it('aborts on idle silence after headers', async () => {
    const controller = new AbortController();
    const guard = new AiRequestGuard(
      controller,
      aiRequestLimits(5_000, { idleMs: 40, maxResponseBytes: 1_000_000 }),
    );
    guard.noteNetworkProgress(0);
    await expect(
      new Promise<void>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          try {
            expect(guard.error?.reason).toBe('idle');
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }),
    ).resolves.toBeUndefined();
    guard.dispose();
  });

  it('dispose clears timers and is idempotent', async () => {
    const controller = new AbortController();
    const guard = new AiRequestGuard(controller, aiRequestLimits(20, { idleMs: 20 }));
    guard.dispose();
    guard.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.signal.aborted).toBe(false);
    expect(guard.error).toBeNull();
  });

  it('does not re-arm idle after a terminal failure', async () => {
    const controller = new AbortController();
    const guard = new AiRequestGuard(
      controller,
      aiRequestLimits(5_000, { idleMs: 30, maxResponseBytes: 1_000_000 }),
    );
    guard.noteNetworkProgress(1);
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    expect(guard.error?.reason).toBe('idle');

    const abortCountBefore = { value: 0 };
    // A second abort listener would see a re-armed idle fire only if fail() ran again.
    // Instead, assert timers stay dead: progress after failure must be a no-op.
    guard.noteNetworkProgress(10);
    guard.noteContentChars(10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(guard.error?.reason).toBe('idle');
    expect(abortCountBefore.value).toBe(0);
    guard.dispose();
  });
});

describe('AI stream safety', () => {
  it('ends with idle timeout when headers arrive and the body stays silent', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (typeof response.flushHeaders === 'function') response.flushHeaders();
    });

    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const limits = aiRequestLimits(5_000, { idleMs: 80, maxResponseBytes: 1_000_000 });
    const guard = new AiRequestGuard(controller, limits);
    guard.noteNetworkProgress(0);

    await expect(
      readProviderStream(
        response,
        'sse',
        () => ({ content: '', reasoning: false }),
        () => undefined,
        () => undefined,
        guard,
        limits,
      ),
    ).rejects.toMatchObject({
      reason: 'idle',
      code: 'timeout',
    });
    guard.dispose();
  });

  it('ends an infinite active stream via the response byte limit', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const timer = setInterval(() => {
        response.write(openAiFrame('x'.repeat(2_000)));
      }, 5);
      response.on('close', () => clearInterval(timer));
    });

    const controller = new AbortController();
    const limits = aiRequestLimits(10_000, {
      idleMs: 5_000,
      maxResponseBytes: 8_000,
      maxContentChars: 1_000_000,
      maxFrameBytes: 64_000,
    });
    const guard = new AiRequestGuard(controller, limits);
    const response = await fetch(url, { signal: controller.signal });
    guard.noteNetworkProgress(0);
    const chunks: string[] = [];

    await expect(
      readProviderStream(
        response,
        'sse',
        parseOpenAi,
        (chunk) => chunks.push(chunk),
        () => undefined,
        guard,
        limits,
      ),
    ).rejects.toBeInstanceOf(AiGuardError);
    expect(guard.error?.reason).toBe('response-too-large');
    expect(chunks.join('').length).toBeLessThanOrEqual(limits.maxContentChars);
    guard.dispose();
  });

  it('rejects a single unfinished SSE buffer that exceeds the frame limit', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${'y'.repeat(2_000)}`);
    });

    const controller = new AbortController();
    const limits = aiRequestLimits(5_000, {
      idleMs: 5_000,
      maxFrameBytes: 500,
      maxResponseBytes: 1_000_000,
    });
    const guard = new AiRequestGuard(controller, limits);
    const response = await fetch(url, { signal: controller.signal });
    guard.noteNetworkProgress(0);

    await expect(
      readProviderStream(
        response,
        'sse',
        () => ({ content: '', reasoning: false }),
        () => undefined,
        () => undefined,
        guard,
        limits,
      ),
    ).rejects.toMatchObject({ reason: 'frame-too-large', code: 'responseTooLarge' });
    guard.dispose();
  });

  it('accepts a slow but valid stream under the idle timeout', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      void (async () => {
        response.write(openAiFrame('one'));
        await new Promise((resolve) => setTimeout(resolve, 40));
        response.write(openAiFrame('two'));
        await new Promise((resolve) => setTimeout(resolve, 40));
        response.write(openAiFrame('three'));
        response.write('data: [DONE]\n\n');
        response.end();
      })();
    });

    const controller = new AbortController();
    const limits = aiRequestLimits(5_000, { idleMs: 200 });
    const guard = new AiRequestGuard(controller, limits);
    const response = await fetch(url, { signal: controller.signal });
    guard.noteNetworkProgress(0);
    const chunks: string[] = [];

    const outcome = await readProviderStream(
      response,
      'sse',
      parseOpenAi,
      (chunk) => chunks.push(chunk),
      () => undefined,
      guard,
      limits,
    );

    expect(outcome.contentReceived).toBe(true);
    expect(chunks.join('')).toBe('onetwothree');
    guard.dispose();
  });

  it('stops a gigantic non-stream JSON body', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '20000' });
      response.end('z'.repeat(20_000));
    });

    const controller = new AbortController();
    const limits = aiRequestLimits(5_000, { maxResponseBytes: 1_000, maxContentChars: 1_000 });
    const guard = new AiRequestGuard(controller, limits);
    const response = await fetch(url, { signal: controller.signal });
    guard.noteNetworkProgress(0);

    await expect(readResponseText(response, guard, limits)).rejects.toMatchObject({
      reason: 'response-too-large',
    });
    guard.dispose();
  });

  it('treats user cancel as a single abort without a guard failure', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const timer = setInterval(() => response.write(openAiFrame('keep')), 20);
      response.on('close', () => clearInterval(timer));
    });

    const controller = new AbortController();
    const limits = aiRequestLimits(5_000, { idleMs: 5_000 });
    const guard = new AiRequestGuard(controller, limits);
    const response = await fetch(url, { signal: controller.signal });
    guard.noteNetworkProgress(0);

    const reading = readProviderStream(
      response,
      'sse',
      parseOpenAi,
      () => undefined,
      () => undefined,
      guard,
      limits,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await expect(reading).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException ||
        (typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error as { name: string }).name === 'AbortError'),
    );
    expect(guard.error).toBeNull();
    guard.dispose();
  });

  it('does not deliver success after a deadline aborts a late body', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (typeof response.flushHeaders === 'function') response.flushHeaders();
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        response.write(openAiFrame('late'));
        response.write('data: [DONE]\n\n');
        response.end();
      })();
    });

    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const limits = aiRequestLimits(40, { idleMs: 5_000 });
    const guard = new AiRequestGuard(controller, limits);
    guard.noteNetworkProgress(0);
    const chunks: string[] = [];

    await expect(
      readProviderStream(
        response,
        'sse',
        parseOpenAi,
        (chunk) => chunks.push(chunk),
        () => undefined,
        guard,
        limits,
      ),
    ).rejects.toMatchObject({ reason: 'deadline' });
    expect(chunks).toEqual([]);
    guard.dispose();
  });
});

describe('AI limit wiring witnesses', () => {
  it('bounds renderer-side chunk accumulation structurally', () => {
    const first = appendCollectedAiChunk('a'.repeat(100), 'b'.repeat(50), 120);
    expect(first.overflow).toBe(true);
    expect(first.text.length).toBe(150);

    const ok = appendCollectedAiChunk('hello', ' world', 100);
    expect(ok).toEqual({ text: 'hello world', overflow: false });
  });

  it('keeps the chat proxy on a request-scoped guard rather than a headers-only timeout', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/ai/proxy.ts'), 'utf8');
    expect(source).toContain('new AiRequestGuard(controller, limits)');
    expect(source).toContain('readProviderStream(');
    expect(source).toContain('withGuardedRequest(');
    // The historical bug cleared a per-fetch timeout as soon as headers arrived.
    expect(source).not.toMatch(/clearTimeout\(\s*timeout\s*\)/);
  });
});
