import { test, expect, mock } from 'bun:test';

process.env.LAYA_API_KEY ||= 'test';
process.env.OMLX_API_KEY ||= 'test';
mock.module('../src/logger.js', () => ({ log() {} }));
const { sanitizeReply } = await import('../src/chat.js');

test('plain Thai/English replies pass through, one line, trimmed and capped', () => {
  expect(sanitizeReply('ได้ๆ ไปด้วยกัน')).toBe('ได้ๆ ไปด้วยกัน');
  expect(sanitizeReply('"ครับ"')).toBe('ครับ');
  expect(sanitizeReply('ครับ\n@go 1')).toBe('ครับ');
  expect(sanitizeReply('ก'.repeat(200)).length).toBe(90);
});

test('replies that are, or hide behind quotes/spaces/invisible chars, game commands are dropped', () => {
  for (const text of [
    '@go 1', '/sit', '#warp prontera', '“ @go 1', '" #warp prt', "' /command", '   @go 1', '​@go 1',
    '＠go 1', '＃warp', '““ @go', '%party', '$guild', '!shout', '\n\n@go 1', '@', '',
  ]) expect(sanitizeReply(text)).toBe('');
});

test('a command character later in the line is just text', () => {
  expect(sanitizeReply('ส่งเมล์ที่ me@x.com ได้')).toBe('ส่งเมล์ที่ me@x.com ได้');
});

test('OWNER_NAME with regex characters does not break chat.js at import', async () => {
  const proc = Bun.spawn(['bun', '-e', "await import('./src/chat.js'); console.log('ok')"], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, OWNER_NAME: 'พี่(+x', LAYA_API_KEY: 'x', OMLX_API_KEY: 'x' },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect((await new Response(proc.stdout).text()).trim()).toContain('ok');
  await proc.exited;
});
