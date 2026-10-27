import { canDecideStep, parseSteps, skippedLevels, stepAt, type Approver, type RoutedRequest } from './approval-routing';

const base: Approver = { userId: 'u', employeeId: 'e', companyWide: false, departmentIds: [], employeeIds: [], roles: [], superAdmin: false };
const deptManager: Approver = { ...base, userId: 'u-mgr', employeeId: 'e-mgr', departmentIds: ['eng'], roles: ['DEPARTMENT_MANAGER'] };
const projectManager: Approver = { ...base, userId: 'u-pm', employeeId: 'e-pm', employeeIds: ['e-1'], roles: ['PROJECT_MANAGER'] };
const hr: Approver = { ...base, userId: 'u-hr', employeeId: 'e-hr', companyWide: true, roles: ['HR_ADMIN'] };
const admin: Approver = { ...base, userId: 'u-admin', employeeId: null, companyWide: true, roles: ['SUPER_ADMIN'], superAdmin: true };
const request = (over: Partial<RoutedRequest> = {}): RoutedRequest => ({ employeeId: 'e-1', departmentId: 'eng', step: 'MANAGER', priorApproverIds: [], ...over });

describe('approval steps', () => {
  it('MANAGER: the department manager and the supervisor, nobody else', () => {
    expect(canDecideStep(deptManager, request())).toBe(true);
    expect(canDecideStep(projectManager, request())).toBe(true);
    expect(canDecideStep(deptManager, request({ departmentId: 'ops' }))).toBe(false);
    expect(canDecideStep(projectManager, request({ employeeId: 'e-2' }))).toBe(false);
    expect(canDecideStep(hr, request())).toBe(false);
  });

  it('a role step: holders of the role only', () => {
    expect(canDecideStep(hr, request({ step: 'HR_ADMIN' }))).toBe(true);
    expect(canDecideStep(deptManager, request({ step: 'HR_ADMIN' }))).toBe(false);
    expect(canDecideStep(hr, request({ step: 'GENERAL_MANAGER', departmentId: 'ops' }))).toBe(false);
  });

  it('the fallback step: company-wide approvers', () => {
    expect(canDecideStep(hr, request({ step: 'ANY_APPROVER' }))).toBe(true);
    expect(canDecideStep(deptManager, request({ step: 'ANY_APPROVER' }))).toBe(false);
  });

  it('SUPER_ADMIN may decide any step', () => {
    for (const step of ['MANAGER', 'HR_ADMIN', 'ANY_APPROVER', 'CUSTOM']) expect(canDecideStep(admin, request({ step }))).toBe(true);
  });

  it('never the requester, never two steps of one request, nothing once decided', () => {
    expect(canDecideStep(hr, request({ step: 'HR_ADMIN', employeeId: 'e-hr' }))).toBe(false);
    expect(canDecideStep(admin, request({ step: 'HR_ADMIN', priorApproverIds: ['u-admin'] }))).toBe(false);
    expect(canDecideStep(hr, request({ step: 'HR_ADMIN', priorApproverIds: ['u-hr'] }))).toBe(false);
    expect(canDecideStep(hr, request({ step: null }))).toBe(false);
  });
});

describe('chain helpers', () => {
  it('reads stored chains and positions', () => {
    expect(parseSteps(['MANAGER', 'HR_ADMIN'])).toEqual(['MANAGER', 'HR_ADMIN']);
    expect(parseSteps(null)).toEqual(['MANAGER']);
    expect(parseSteps([])).toEqual(['MANAGER']);
    expect(stepAt(['MANAGER', 'HR_ADMIN'], 2)).toBe('HR_ADMIN');
    expect(stepAt(['MANAGER'], 2)).toBeNull();
  });

  it('reports levels passed over without a decision', () => {
    expect(skippedLevels('PENDING', 2, 3, [])).toEqual([1]);
    expect(skippedLevels('PENDING', 2, 3, [{ level: 1, decision: 'APPROVED' }])).toEqual([]);
    expect(skippedLevels('APPROVED', 1, 3, [{ level: 1, decision: 'APPROVED' }])).toEqual([2, 3]);
    expect(skippedLevels('APPROVED', 3, 3, [{ level: 1, decision: 'APPROVED' }, { level: 3, decision: 'APPROVED' }])).toEqual([2]);
    expect(skippedLevels('REJECTED', 2, 3, [{ level: 2, decision: 'REJECTED' }])).toEqual([1]);
    expect(skippedLevels('CANCELLED', 1, 2, [])).toEqual([]);
  });
});
