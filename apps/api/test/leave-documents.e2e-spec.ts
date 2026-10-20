import type { INestApplication } from '@nestjs/common';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, futureSunday, seedPeople, seedRequestCatalog } from './request-fixtures';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

let catalog: Awaited<ReturnType<typeof seedRequestCatalog>>;
let people: Awaited<ReturnType<typeof seedPeople>>;
beforeEach(async () => {
  await resetDb();
  catalog = await seedRequestCatalog();
  people = await seedPeople(app);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);

async function leaveRequest(as: typeof people.http.emp, leaveTypeId: string, ahead = 7) {
  const day = futureSunday(ahead);
  const res = await as.post('/api/v1/leave/requests').send({ leaveTypeId, mode: 'FULL_DAY', startDate: day, endDate: day, reason: 'Doctor visit' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('leave documents', () => {
  it('the requester attaches an image and a PDF; they appear on the request and the manager can open them', async () => {
    const id = await leaveRequest(people.http.emp, catalog.annual.id);
    const png = await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PNG, { filename: 'تقرير طبي.png', contentType: 'image/png' });
    expect(png.status).toBe(201);
    expect(png.body).toMatchObject({ fileName: 'تقرير طبي.png', mimeType: 'image/png', size: PNG.length });
    // The type comes from the content: a PDF named .jpg is stored as a PDF.
    const pdf = await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PDF, { filename: 'note.jpg', contentType: 'image/jpeg' });
    expect(pdf.body).toMatchObject({ fileName: 'note.pdf', mimeType: 'application/pdf' });
    expect(await auditActions(id)).toEqual(expect.arrayContaining(['LEAVE_DOCUMENT_ADD']));

    const mine = await people.http.emp.get('/api/v1/leave/me/requests');
    expect(mine.body.find((r: { id: string }) => r.id === id).documents).toHaveLength(2);

    const open = await people.http.mgr.get(`/api/v1/leave/documents/${png.body.id}/content`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(open.status).toBe(200);
    expect(open.headers['content-type']).toBe('image/png');
    expect(open.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(open.body as Buffer, PNG)).toBe(0);

    // Other departments' managers and other employees cannot see it.
    expect((await people.http.opsMgr.get(`/api/v1/leave/documents/${png.body.id}/content`)).status).toBe(404);
    expect((await people.http.emp2.get(`/api/v1/leave/documents/${png.body.id}/content`)).status).toBe(404);
  });

  it('rejects other file types, oversized files and more than five documents', async () => {
    const id = await leaveRequest(people.http.emp, catalog.annual.id);
    const exe = await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', Buffer.from('MZ\x90\x00 not a document'), { filename: 'virus.pdf', contentType: 'application/pdf' });
    expect(exe.status).toBe(400);
    expectErrorEnvelope(exe.body, 'ATTACHMENT_TYPE_NOT_ALLOWED');

    const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', big, { filename: 'scan.pdf' });
    expect(tooBig.status).toBe(400);
    expectErrorEnvelope(tooBig.body, 'ATTACHMENT_TOO_LARGE');

    for (let i = 0; i < 5; i++) {
      expect((await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PNG, { filename: `p${i}.png` })).status).toBe(201);
    }
    const sixth = await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PNG, { filename: 'p6.png' });
    expect(sixth.status).toBe(409);
    expectErrorEnvelope(sixth.body, 'ATTACHMENT_LIMIT_REACHED');

    const missing = await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).send({});
    expect(missing.status).toBe(400);
  });

  it('only the requester or HR may add; managers may not; the requester removes own documents only while pending', async () => {
    const id = await leaveRequest(people.http.emp, catalog.annual.id);
    const byMgr = await people.http.mgr.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PNG, { filename: 'm.png' });
    expect(byMgr.status).toBe(403);
    expectErrorEnvelope(byMgr.body, 'ATTACHMENT_NOT_ALLOWED');
    expect((await people.http.opsMgr.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PNG, { filename: 'm.png' })).status).toBe(404);
    const byHr = await people.http.hr.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PNG, { filename: 'hr.png' });
    expect(byHr.status).toBe(201);

    const own = (await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PDF, { filename: 'own.pdf' })).body;
    // The requester cannot remove HR's document.
    expect((await people.http.emp.delete(`/api/v1/leave/documents/${byHr.body.id}`)).status).toBe(403);

    await people.http.mgr.post(`/api/v1/approvals/leave/${id}/approve`).send({});
    // Approved: the requester can still add (a late doctor's note) but no longer remove.
    expect((await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PNG, { filename: 'late.png' })).status).toBe(201);
    expect((await people.http.emp.delete(`/api/v1/leave/documents/${own.id}`)).status).toBe(403);
    expect((await people.http.hr.delete(`/api/v1/leave/documents/${own.id}`)).status).toBe(204);
    expect(await auditActions(id)).toEqual(expect.arrayContaining(['LEAVE_DOCUMENT_ADD', 'LEAVE_DOCUMENT_DELETE']));
  });

  it('documents of sensitive leave are hidden from managers but visible to HR', async () => {
    const id = await leaveRequest(people.http.emp, catalog.sick.id);
    const doc = (await people.http.emp.post(`/api/v1/leave/requests/${id}/documents`).attach('file', PDF, { filename: 'sick-note.pdf' })).body;
    expect((await people.http.mgr.get(`/api/v1/leave/documents/${doc.id}/content`)).status).toBe(404);
    const asMgr = await people.http.mgr.get(`/api/v1/leave/requests/${id}`);
    expect(asMgr.body).toMatchObject({ confidential: true, documents: [] });
    expect((await people.http.hr.get(`/api/v1/leave/documents/${doc.id}/content`)).status).toBe(200);
    const pending = await people.http.hr.get('/api/v1/approvals?tab=PENDING');
    const item = pending.body.items.find((i: { id: string }) => i.id === id);
    expect(item.leave.documents).toEqual([expect.objectContaining({ id: doc.id, fileName: 'sick-note.pdf' })]);
  });
});
