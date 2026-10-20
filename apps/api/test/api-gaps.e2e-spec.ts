// API gaps for the UX overhaul: holiday / leave on the status DTO, Arabic department names on the dashboard,
// and Arabic-folding employee search (fictional people only).
import type { INestApplication } from '@nestjs/common';
import { addDays, dateOnly, localDate, localDateTime, startOfLocalDay } from '../src/common/time';
import { as, createUser, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

describe('api gaps (e2e)', () => {
  let app: INestApplication;
  let eng: { id: string };
  let ops: { id: string };
  let hr: ReturnType<typeof as>;
  const today = () => localDate(new Date());

  const usernames = (body: { items: { user: { username: string } | null }[] }) => body.items.map((e) => e.user?.username).sort();

  beforeAll(async () => {
    await resetDb();
    app = await createTestApp();
    eng = await prisma.department.create({ data: { code: 'ENG', name: 'Engineering', nameAr: 'الهندسة' } });
    ops = await prisma.department.create({ data: { code: 'OPS', name: 'Operations' } });
    await createUser({ username: 'hr', roles: ['HR_ADMIN'], departmentId: null });
    await createUser({ username: 'opsmgr', roles: ['DEPARTMENT_MANAGER'], departmentId: ops.id, manages: [ops.id] });
    const people: [string, string, string | null, string][] = [
      ['ahmad', 'Ahmad Ibrahim', 'أحمد إبراهيم', eng.id],
      ['fatima', 'Fatima Zahra', 'فاطمة الزهراء', eng.id],
      ['salma', 'Salma Haddad', 'سَلْمى حدّاد', eng.id],
      ['huda', 'Huda Nasser', 'هدى ناصر', ops.id],
      ['plain', 'Plain Latin', null, eng.id],
    ];
    for (const [username, fullName, fullNameAr, departmentId] of people) {
      const u = await createUser({ username, roles: ['EMPLOYEE'], departmentId, code: `AG-${username.toUpperCase()}` });
      await prisma.employee.update({ where: { id: u.employeeId }, data: { fullName, fullNameAr } });
    }
    hr = as(app, await webLogin(app, 'hr'));
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET /attendance/me/status: todayHoliday and todayLeave', () => {
    let sensitive: { id: string };
    let hourly: { id: string };
    let remote: { id: string };

    beforeAll(async () => {
      [sensitive, hourly, remote] = await Promise.all([
        prisma.leaveType.create({ data: { code: 'AG-SICK', name: 'Sick leave', nameAr: 'إجازة مرضية', isSensitive: true } }),
        prisma.leaveType.create({ data: { code: 'AG-HOURLY', name: 'Hourly leave', unit: 'HOUR' } }),
        prisma.leaveType.create({ data: { code: 'AG-REMOTE', name: 'Remote work', isRemoteWork: true } }),
      ]);
    });
    afterEach(async () => {
      await prisma.leaveRequest.deleteMany({});
      await prisma.holiday.deleteMany({});
    });

    const approved = (employeeId: string, leaveTypeId: string, startAt: Date, endAt: Date, mode = 'FULL_DAY') =>
      prisma.leaveRequest.create({
        data: { employeeId, leaveTypeId, startAt, endAt, mode, minutes: 480, reason: 'Test', status: 'APPROVED', decidedAt: new Date() },
      });
    const sessions = new Map<string, ReturnType<typeof as>>();
    const statusOf = async (username: string) => {
      if (!sessions.has(username)) sessions.set(username, as(app, await webLogin(app, username)));
      const res = await sessions.get(username)!.get('/api/v1/attendance/me/status');
      expect(res.status).toBe(200);
      return res.body;
    };
    const employeeId = async (username: string) => (await prisma.user.findUniqueOrThrow({ where: { username } })).employeeId!;

    it('both are null on an ordinary day', async () => {
      const body = await statusOf('plain');
      expect(body).toMatchObject({ todayHoliday: null, todayLeave: null });
      expect(body.today.workDate).toBe(today());
    });

    it('reports today\'s public holiday with its Arabic name', async () => {
      await prisma.holiday.create({ data: { date: dateOnly.toDb(today()), name: 'Founders Day', nameAr: 'يوم المؤسسين' } });
      expect((await statusOf('plain')).todayHoliday).toEqual({ name: 'Founders Day', nameAr: 'يوم المؤسسين' });
      // Tomorrow's holiday is not today's.
      await prisma.holiday.deleteMany({});
      await prisma.holiday.create({ data: { date: dateOnly.toDb(addDays(today(), 1)), name: 'Tomorrow', nameAr: null } });
      expect((await statusOf('plain')).todayHoliday).toBeNull();
    });

    it('names the employee\'s own approved leave, sensitive types included', async () => {
      const id = await employeeId('fatima');
      const start = startOfLocalDay(addDays(today(), -1));
      const end = startOfLocalDay(addDays(today(), 2));
      await approved(id, sensitive.id, start, end);
      expect((await statusOf('fatima')).todayLeave).toEqual({
        leaveTypeName: 'Sick leave', leaveTypeNameAr: 'إجازة مرضية', mode: 'FULL_DAY', startAt: start.toISOString(), endAt: end.toISOString(),
      });
      // Someone else's leave is not mine.
      expect((await statusOf('salma')).todayLeave).toBeNull();
    });

    it('reports a partial-day leave, prefers a full day, and ignores pending leave and remote work', async () => {
      const id = await employeeId('salma');
      const from = localDateTime(today(), 600);
      const to = localDateTime(today(), 720);
      await approved(id, hourly.id, from, to, 'HOURLY');
      await prisma.leaveRequest.create({
        data: { employeeId: id, leaveTypeId: sensitive.id, startAt: startOfLocalDay(today()), endAt: startOfLocalDay(addDays(today(), 1)), minutes: 480, reason: 'Pending', status: 'PENDING' },
      });
      await approved(id, remote.id, startOfLocalDay(today()), startOfLocalDay(addDays(today(), 1)));
      const body = await statusOf('salma');
      expect(body.todayLeave).toEqual({ leaveTypeName: 'Hourly leave', leaveTypeNameAr: null, mode: 'HOURLY', startAt: from.toISOString(), endAt: to.toISOString() });
      expect(body.location.remote).toBe(true);

      await approved(id, sensitive.id, startOfLocalDay(today()), startOfLocalDay(addDays(today(), 1)));
      expect((await statusOf('salma')).todayLeave).toMatchObject({ leaveTypeName: 'Sick leave', mode: 'FULL_DAY' });
    });
  });

  it('GET /dashboard/summary returns nameAr per department', async () => {
    const res = await hr.get('/api/v1/dashboard/summary');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.departments.map((d: { departmentId: string | null }) => [d.departmentId, d]));
    expect(byId.get(eng.id)).toMatchObject({ name: 'Engineering', nameAr: 'الهندسة' });
    expect(byId.get(ops.id)).toMatchObject({ name: 'Operations', nameAr: null });
    expect(byId.get(null)).toMatchObject({ name: 'Unassigned', nameAr: null });
  });

  describe('GET /employees?search= folds Arabic letters', () => {
    const search = async (term: string, extra: Record<string, string | number> = {}) => {
      const res = await hr.get('/api/v1/employees').query({ search: term, pageSize: 50, ...extra });
      expect(res.status).toBe(200);
      return res.body;
    };

    it.each([
      ['احمد', ['ahmad']], // أ vs ا
      ['ابراهيم', ['ahmad']], // إ vs ا
      ['أحمد إبراهيم', ['ahmad']], // stored spelling still matches
      ['فاطمه', ['fatima']], // ة vs ه
      ['سلمي', ['salma']], // ى vs ي, and tashkeel in the stored name
      ['حداد', ['salma']], // shadda in the stored name
      ['أَحْمَـــد', ['ahmad']], // tashkeel and tatweel in the query
      ['هدي  ناصر', ['huda']], // extra spaces in the query
      ['زهراء', ['fatima']],
    ])('"%s" finds %j', async (term, expected) => {
      expect(usernames(await search(term))).toEqual(expected);
    });

    it('keeps Latin, code and username matching', async () => {
      expect(usernames(await search('ibrahim'))).toEqual(['ahmad']);
      expect(usernames(await search('ag-fat'))).toEqual(['fatima']);
      expect(usernames(await search('plain'))).toEqual(['plain']);
      expect(usernames(await search('محمد'))).toEqual([]);
    });

    it('keeps paging, filters and scope', async () => {
      const page = await search('ا', { pageSize: 1, page: 2 });
      // Every Arabic name here has an alef once folded; Latin-only names do not match.
      expect(page).toMatchObject({ total: 4, page: 2, pageSize: 1 });
      expect(page.items).toHaveLength(1);
      expect(usernames(await search('ا', { departmentId: ops.id }))).toEqual(['huda']);

      const opsMgr = as(app, await webLogin(app, 'opsmgr'));
      const scoped = await opsMgr.get('/api/v1/employees').query({ search: 'احمد' });
      expect(scoped.status).toBe(200);
      expect(scoped.body.total).toBe(0);
      const own = await opsMgr.get('/api/v1/employees').query({ search: 'هدي' });
      expect(usernames(own.body)).toEqual(['huda']);

      const ahmad = await prisma.employee.findFirstOrThrow({ where: { employeeCode: 'AG-AHMAD' } });
      await prisma.employee.update({ where: { id: ahmad.id }, data: { isActive: false } });
      expect(usernames(await search('احمد'))).toEqual([]);
      expect(usernames(await search('احمد', { status: 'inactive' }))).toEqual(['ahmad']);
      await prisma.employee.update({ where: { id: ahmad.id }, data: { isActive: true } });
    });

    it('applies the same folding to the live attendance search', async () => {
      const res = await hr.get('/api/v1/dashboard/live').query({ search: 'فاطمه' });
      expect(res.status).toBe(200);
      expect(res.body.items.map((r: { employeeCode: string }) => r.employeeCode)).toEqual(['AG-FATIMA']);
    });
  });
});
