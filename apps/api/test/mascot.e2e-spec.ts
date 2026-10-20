import type { INestApplication } from '@nestjs/common';
import { MASCOT_AUDIO_MAX_BYTES, type MascotConfigDto, type MascotGroupDto, type MascotLineDto } from '@workforce/shared';
import request from 'supertest';
import { createUser, expectErrorEnvelope, webLogin, type WebSession } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function client(s: WebSession) {
  const server = app.getHttpServer();
  const write = (r: request.Test) => r.set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
  return {
    get: (url: string) => request(server).get(url).set('Cookie', s.cookie),
    getBytes: (url: string) => request(server).get(url).set('Cookie', s.cookie).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }),
    post: (url: string) => write(request(server).post(url)),
    patch: (url: string) => write(request(server).patch(url)),
    put: (url: string) => write(request(server).put(url)),
    delete: (url: string) => write(request(server).delete(url)),
  };
}
type Client = ReturnType<typeof client>;

/** Three MPEG-1 layer III frames (128 kbit/s, 44.1 kHz, 417 bytes each) of silence. */
const MP3 = Buffer.concat(Array.from({ length: 3 }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)])));
/** 0.01 s of 8 kHz mono 8-bit PCM. */
function wav(): Buffer {
  const data = Buffer.alloc(80, 0x80);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let hr: Client;
let emp: Client;
let hrUserId: string;
beforeEach(async () => {
  await resetDb();
  const [hrUser] = await Promise.all([
    createUser({ username: 'hr', roles: ['HR_ADMIN'] }),
    createUser({ username: 'emp', roles: ['EMPLOYEE'] }),
  ]);
  hrUserId = hrUser.userId;
  hr = client(await webLogin(app, 'hr'));
  emp = client(await webLogin(app, 'emp'));
});

async function makeGroup(body: Record<string, unknown> = {}): Promise<MascotGroupDto> {
  const res = await hr.post('/api/v1/mascot/groups').send({ name: 'ترحيب', trigger: 'GREETING', ...body });
  expect(res.status).toBe(201);
  return res.body as MascotGroupDto;
}
async function makeLine(groupId: string, body: Record<string, unknown> = {}): Promise<MascotLineDto> {
  const res = await hr.post(`/api/v1/mascot/groups/${groupId}/lines`).send({ locale: 'ar', text: 'هلا يا {name}', ...body });
  expect(res.status).toBe(201);
  return res.body as MascotLineDto;
}
const auditActions = async (entityId: string) =>
  (await prisma.auditLog.findMany({ where: { entityId }, orderBy: { seq: 'asc' } })).map((a) => a.action);

describe('mascot content', () => {
  it('HR creates, updates and deletes groups and lines; every change is audited', async () => {
    const g = await makeGroup({
      description: 'Morning', conditions: { timeTo: '12:00', weekdays: [4, 0], arrival: [], workVsRequired: { min: -30, max: 30 } },
      priority: 5, moods: ['happy', 'wink'],
    });
    expect(g).toMatchObject({
      name: 'ترحيب', trigger: 'GREETING', priority: 5, moods: ['happy', 'wink'], isActive: true, lines: [],
      // Empty lists are dropped, weekdays sorted.
      conditions: { timeTo: '12:00', weekdays: [0, 4], workVsRequired: { min: -30, max: 30 } },
    });
    const l = await makeLine(g.id, { mood: 'party' });
    expect(l).toMatchObject({ groupId: g.id, locale: 'ar', text: 'هلا يا {name}', mood: 'party', audioUrl: null, audioMime: null, isActive: true });

    const upd = await hr.patch(`/api/v1/mascot/groups/${g.id}`).send({ priority: -3, conditions: { workday: true }, description: null });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ priority: -3, conditions: { workday: true }, description: null, name: 'ترحيب' });
    expect(upd.body.lines).toHaveLength(1);

    const lu = await hr.patch(`/api/v1/mascot/lines/${l.id}`).send({ text: '  Hi {name}  ', locale: 'en', mood: null });
    expect(lu.status).toBe(200);
    expect(lu.body).toMatchObject({ text: 'Hi {name}', locale: 'en', mood: null });

    expect((await hr.delete(`/api/v1/mascot/lines/${l.id}`)).status).toBe(204);
    expect((await hr.delete(`/api/v1/mascot/lines/${l.id}`)).status).toBe(404);
    expect((await hr.delete(`/api/v1/mascot/groups/${g.id}`)).status).toBe(204);

    expect(await auditActions(g.id)).toEqual(['MASCOT_GROUP_CREATE', 'MASCOT_GROUP_UPDATE', 'MASCOT_GROUP_DELETE']);
    expect(await auditActions(l.id)).toEqual(['MASCOT_LINE_CREATE', 'MASCOT_LINE_UPDATE', 'MASCOT_LINE_DELETE']);
    const row = await prisma.auditLog.findFirst({ where: { entityId: g.id, action: 'MASCOT_GROUP_CREATE' } });
    expect(row?.actorUserId).toBe(hrUserId);
  });

  it('validates conditions, moods, text and priority strictly', async () => {
    const bad = async (body: Record<string, unknown>) => {
      const res = await hr.post('/api/v1/mascot/groups').send({ name: 'x', trigger: 'POKE', ...body });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
    };
    await bad({ trigger: 'LUNCHTIME' });
    await bad({ conditions: { timeFrom: '24:00' } });
    await bad({ conditions: { timeTo: '9:00' } });
    await bad({ conditions: { weekdays: [7] } });
    await bad({ conditions: { weekdays: [1, 1] } });
    await bad({ conditions: { weekdays: [1.5] } });
    await bad({ conditions: { arrival: ['SOON'] } });
    await bad({ conditions: { earlyBefore: 'noon' } });
    await bad({ conditions: { workVsRequired: { min: 10, max: 5 } } });
    await bad({ conditions: { workVsRequired: { min: -1441 } } });
    await bad({ conditions: { workVsRequired: { min: 1, extra: 2 } } });
    await bad({ conditions: { breakTypeCodes: Array.from({ length: 21 }, (_, i) => `C${i}`) } });
    await bad({ conditions: { errorCodes: ['x'.repeat(41)] } });
    await bad({ conditions: { surprise: true } });
    await bad({ conditions: 'always' });
    await bad({ moods: ['angry'] });
    await bad({ priority: 101 });
    await bad({ name: '' });
    await bad({ unknownField: 1 });
    const nested = await hr.post('/api/v1/mascot/groups').send({ name: 'x', trigger: 'POKE', conditions: { timeFrom: '25:00', workVsRequired: { min: 2000 } } });
    expect(nested.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['conditions.timeFrom', 'conditions.workVsRequired.min']);

    const g = await makeGroup();
    const badLine = async (body: Record<string, unknown>) =>
      expect((await hr.post(`/api/v1/mascot/groups/${g.id}/lines`).send({ locale: 'ar', text: 'ok', ...body })).status).toBe(400);
    await badLine({ text: '' });
    await badLine({ text: '   ' });
    await badLine({ text: 'x'.repeat(301) });
    await badLine({ locale: 'fr' });
    await badLine({ mood: 'angry' });
    expect((await hr.patch(`/api/v1/mascot/groups/${g.id}`).send({ name: null })).status).toBe(400);
    expect((await hr.post('/api/v1/mascot/groups/00000000-0000-4000-8000-000000000000/lines').send({ locale: 'ar', text: 'x' })).status).toBe(404);
  });

  it('employees see only active content and cannot write or ask for everything', async () => {
    const active = await makeGroup({ priority: 1 });
    const inactive = await makeGroup({ isActive: false });
    const on = await makeLine(active.id);
    const off = await makeLine(active.id, { isActive: false });
    await makeLine(inactive.id);

    const mine = await emp.get('/api/v1/mascot/config');
    expect(mine.status).toBe(200);
    const cfg = mine.body as MascotConfigDto;
    expect(cfg.enabled).toBe(true);
    expect(cfg.groups.map((g) => g.id)).toEqual([active.id]);
    expect(cfg.groups[0].lines.map((l) => l.id)).toEqual([on.id]);
    expect(typeof cfg.version).toBe('string');

    expect((await emp.get('/api/v1/mascot/config?all=true')).status).toBe(403);
    const all = (await hr.get('/api/v1/mascot/config?all=true')).body as MascotConfigDto;
    expect(all.groups.map((g) => g.id)).toEqual([active.id, inactive.id]);
    expect(all.groups[0].lines.map((l) => l.id)).toEqual([on.id, off.id]);
    // Without all=true HR gets the same view as employees.
    expect((await hr.get('/api/v1/mascot/config')).body.groups).toHaveLength(1);

    const writes: (() => request.Test)[] = [
      () => emp.post('/api/v1/mascot/groups').send({ name: 'x', trigger: 'POKE' }),
      () => emp.patch(`/api/v1/mascot/groups/${active.id}`).send({ priority: 2 }),
      () => emp.delete(`/api/v1/mascot/groups/${active.id}`),
      () => emp.post(`/api/v1/mascot/groups/${active.id}/lines`).send({ locale: 'ar', text: 'x' }),
      () => emp.patch(`/api/v1/mascot/lines/${on.id}`).send({ text: 'x' }),
      () => emp.delete(`/api/v1/mascot/lines/${on.id}`),
      () => emp.put(`/api/v1/mascot/lines/${on.id}/audio`).attach('file', MP3, { filename: 'a.mp3', contentType: 'audio/mpeg' }),
      () => emp.delete(`/api/v1/mascot/lines/${on.id}/audio`),
      () => emp.put('/api/v1/mascot/enabled').send({ enabled: false }),
    ];
    for (const write of writes) {
      const res = await write();
      expect(res.status).toBe(403);
      expectErrorEnvelope(res.body, 'FORBIDDEN');
    }
    expect((await request(app.getHttpServer()).get('/api/v1/mascot/config')).status).toBe(401);
  });

  it('the version changes when content changes', async () => {
    const g = await makeGroup();
    await makeLine(g.id);
    const v1 = (await emp.get('/api/v1/mascot/config')).body.version;
    expect((await emp.get('/api/v1/mascot/config')).body.version).toBe(v1);
    await hr.patch(`/api/v1/mascot/groups/${g.id}`).send({ priority: 9 });
    const v2 = (await emp.get('/api/v1/mascot/config')).body.version;
    expect(v2).not.toBe(v1);
    await hr.put('/api/v1/mascot/enabled').send({ enabled: false });
    const v3 = (await emp.get('/api/v1/mascot/config')).body.version;
    expect(v3).not.toBe(v2);
    const l = (await hr.get('/api/v1/mascot/config?all=true')).body.groups[0].lines[0];
    await hr.put(`/api/v1/mascot/lines/${l.id}/audio`).attach('file', MP3, { filename: 'a.mp3', contentType: 'audio/mpeg' });
    expect((await emp.get('/api/v1/mascot/config')).body.version).not.toBe(v3);
  });

  it('deleting a group deletes its lines and recordings', async () => {
    const g = await makeGroup();
    const l = await makeLine(g.id);
    await hr.put(`/api/v1/mascot/lines/${l.id}/audio`).attach('file', MP3, { filename: 'a.mp3', contentType: 'audio/mpeg' });
    expect((await hr.delete(`/api/v1/mascot/groups/${g.id}`)).status).toBe(204);
    expect(await prisma.mascotLine.count()).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: g.id, action: 'MASCOT_GROUP_DELETE' } });
    expect(JSON.stringify(audit?.before)).toContain(l.id);
  });
});

describe('mascot recordings', () => {
  it('uploads an MP3, serves it with ETag/304/ranges, and removes it', async () => {
    const g = await makeGroup();
    const l = await makeLine(g.id);
    const up = await hr.put(`/api/v1/mascot/lines/${l.id}/audio`).attach('file', MP3, { filename: 'hello.mp3', contentType: 'audio/mpeg' });
    expect(up.status).toBe(200);
    const sha = (await prisma.mascotLine.findUniqueOrThrow({ where: { id: l.id } })).audioSha256!;
    expect(up.body).toMatchObject({ audioMime: 'audio/mpeg', audioUrl: `/api/v1/mascot/lines/${l.id}/audio?v=${sha.slice(0, 12)}` });

    const cfg = (await emp.get('/api/v1/mascot/config')).body as MascotConfigDto;
    const url = cfg.groups[0].lines[0].audioUrl!;
    expect(url).toBe(up.body.audioUrl);
    expect(JSON.stringify(cfg)).not.toContain('"audio"');

    const res = await emp.getBytes(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['content-length']).toBe(String(MP3.length));
    expect(res.headers['etag']).toBe(`"${sha}"`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(Buffer.compare(res.body as Buffer, MP3)).toBe(0);

    const cached = await emp.get(url).set('If-None-Match', `"${sha}"`);
    expect(cached.status).toBe(304);

    const part = await emp.getBytes(url).set('Range', 'bytes=4-13');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-13/${MP3.length}`);
    expect(Buffer.compare(part.body as Buffer, MP3.subarray(4, 14))).toBe(0);
    const outside = await emp.get(url).set('Range', `bytes=${MP3.length}-`);
    expect(outside.status).toBe(416);
    expect(outside.headers['content-range']).toBe(`bytes */${MP3.length}`);

    // A WAV replaces it under a new versioned URL.
    const replaced = await hr.put(`/api/v1/mascot/lines/${l.id}/audio`).attach('file', wav(), { filename: 'r.wav', contentType: 'audio/x-wav' });
    expect(replaced.status).toBe(200);
    expect(replaced.body.audioMime).toBe('audio/wav');
    expect(replaced.body.audioUrl).not.toBe(url);
    expect((await emp.get(replaced.body.audioUrl)).headers['content-type']).toBe('audio/wav');

    const removed = await hr.delete(`/api/v1/mascot/lines/${l.id}/audio`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ audioUrl: null, audioMime: null });
    expect((await emp.get(url)).status).toBe(404);

    expect(await auditActions(l.id)).toEqual(['MASCOT_LINE_CREATE', 'MASCOT_AUDIO_SET', 'MASCOT_AUDIO_SET', 'MASCOT_AUDIO_DELETE']);
    const set = await prisma.auditLog.findFirst({ where: { entityId: l.id, action: 'MASCOT_AUDIO_SET' }, orderBy: { seq: 'asc' } });
    expect(set?.after).toEqual({ mime: 'audio/mpeg', size: MP3.length, sha256: sha });
    expect(set?.before).toBeNull();
  });

  it('rejects wrong types, mismatched content, oversize files and a missing file', async () => {
    const g = await makeGroup();
    const l = await makeLine(g.id);
    const put = () => hr.put(`/api/v1/mascot/lines/${l.id}/audio`);

    const fake = await put().attach('file', Buffer.from('MZ\x90\x00 definitely not audio'), { filename: 'x.mp3', contentType: 'audio/mpeg' });
    expect(fake.status).toBe(400);
    expectErrorEnvelope(fake.body, 'VALIDATION_FAILED');
    const mismatch = await put().attach('file', MP3, { filename: 'x.wav', contentType: 'audio/wav' });
    expect(mismatch.status).toBe(400);
    const notAudio = await put().attach('file', MP3, { filename: 'x.bin', contentType: 'application/octet-stream' });
    expect(notAudio.status).toBe(400);

    const big = Buffer.concat([MP3, Buffer.alloc(MASCOT_AUDIO_MAX_BYTES)]);
    const tooBig = await put().attach('file', big, { filename: 'big.mp3', contentType: 'audio/mpeg' });
    expect(tooBig.status).toBe(413);
    expectErrorEnvelope(tooBig.body, 'VALIDATION_FAILED');

    expect((await put().send({})).status).toBe(400);
    expect((await prisma.mascotLine.findUniqueOrThrow({ where: { id: l.id } })).audio).toBeNull();
    expect(await auditActions(l.id)).toEqual(['MASCOT_LINE_CREATE']);
  });

  it('recordings of inactive lines or groups are only served to managers', async () => {
    const g = await makeGroup();
    const l = await makeLine(g.id, { isActive: false });
    const url = (await hr.put(`/api/v1/mascot/lines/${l.id}/audio`).attach('file', MP3, { filename: 'a.mp3', contentType: 'audio/mpeg' })).body.audioUrl;
    expect((await emp.get(url)).status).toBe(404);
    expect((await hr.get(url)).status).toBe(200);
    await hr.patch(`/api/v1/mascot/lines/${l.id}`).send({ isActive: true });
    expect((await emp.get(url)).status).toBe(200);
    await hr.patch(`/api/v1/mascot/groups/${g.id}`).send({ isActive: false });
    expect((await emp.get(url)).status).toBe(404);
  });
});

describe('mascot on/off switch', () => {
  it('HR turns Nouria off and on; config reflects it and the change is audited as a setting', async () => {
    const off = await hr.put('/api/v1/mascot/enabled').send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ enabled: false });
    expect((await emp.get('/api/v1/mascot/config')).body.enabled).toBe(false);
    expect((await hr.put('/api/v1/mascot/enabled').send({ enabled: 'no' })).status).toBe(400);
    await hr.put('/api/v1/mascot/enabled').send({ enabled: true });
    expect((await emp.get('/api/v1/mascot/config')).body.enabled).toBe(true);
    expect(await auditActions('mascot.enabled')).toEqual(['SETTING_UPDATE', 'SETTING_UPDATE']);
  });

  it('HR picks the language Nouria speaks; config and version follow, employees cannot change it', async () => {
    const before = (await emp.get('/api/v1/mascot/config')).body;
    expect(before.language).toBe('auto');
    expect((await emp.put('/api/v1/mascot/language').send({ language: 'en' })).status).toBe(403);
    const en = await hr.put('/api/v1/mascot/language').send({ language: 'en' });
    expect(en.status).toBe(200);
    expect(en.body).toEqual({ language: 'en' });
    const after = (await emp.get('/api/v1/mascot/config')).body;
    expect(after.language).toBe('en');
    expect(after.version).not.toBe(before.version);
    expect((await hr.put('/api/v1/mascot/language').send({ language: 'fr' })).status).toBe(400);
    await hr.put('/api/v1/mascot/language').send({ language: 'auto' });
    expect((await emp.get('/api/v1/mascot/config')).body.language).toBe('auto');
    expect(await auditActions('mascot.language')).toEqual(['SETTING_UPDATE', 'SETTING_UPDATE']);
  });

  it('serves media-src for audio playback and allows the microphone on the same origin', async () => {
    const res = await emp.get('/api/v1/mascot/config');
    expect(res.headers['content-security-policy']).toContain("media-src 'self' blob:");
    expect(res.headers['permissions-policy']).toContain('microphone=(self)');
  });
});
