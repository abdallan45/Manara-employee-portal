import { afterLeaveApproval, canDecideLeave, canDecideSingle, initialLeaveLevel, levelAudience, type Approver } from './approval-routing';

const manager: Approver = { userId: 'u-mgr', employeeId: 'e-mgr', companyWide: false, departmentIds: ['eng'] };
const hr: Approver = { userId: 'u-hr', employeeId: 'e-hr', companyWide: true, departmentIds: [] };
const leave = (over: Partial<Parameters<typeof canDecideLeave>[1]> = {}) => ({
  employeeId: 'e-1', departmentId: 'eng', currentLevel: 1, isSensitive: false, priorApproverIds: [], ...over,
});

describe('leave routing', () => {
  it('manager acts at level 1 for own departments only', () => {
    expect(canDecideLeave(manager, leave())).toBe(true);
    expect(canDecideLeave(manager, leave({ departmentId: 'ops' }))).toBe(false);
    expect(canDecideLeave(manager, leave({ departmentId: null }))).toBe(false);
    expect(canDecideLeave(manager, leave({ currentLevel: 2 }))).toBe(false);
  });

  it('manager never decides sensitive leave; HR does', () => {
    expect(canDecideLeave(manager, leave({ isSensitive: true }))).toBe(false);
    expect(canDecideLeave(hr, leave({ isSensitive: true }))).toBe(true);
  });

  it('HR acts at any level and in any department', () => {
    expect(canDecideLeave(hr, leave({ currentLevel: 1, departmentId: 'ops' }))).toBe(true);
    expect(canDecideLeave(hr, leave({ currentLevel: 2 }))).toBe(true);
  });

  it('nobody approves their own request or two levels of one request', () => {
    expect(canDecideLeave(manager, leave({ employeeId: 'e-mgr' }))).toBe(false);
    expect(canDecideLeave(hr, leave({ employeeId: 'e-hr' }))).toBe(false);
    expect(canDecideLeave(hr, leave({ currentLevel: 2, priorApproverIds: ['u-hr'] }))).toBe(false);
  });

  it('skips the manager step when there is none, unless there is only one level', () => {
    expect(initialLeaveLevel(1, true)).toBe(1);
    expect(initialLeaveLevel(2, true)).toBe(1);
    expect(initialLeaveLevel(1, false)).toBe(1);
    expect(initialLeaveLevel(2, false)).toBe(2);
    expect(initialLeaveLevel(3, false)).toBe(2);
  });

  it('advances level by level until approvalLevels', () => {
    expect(afterLeaveApproval(1, 1)).toEqual({ final: true });
    expect(afterLeaveApproval(1, 2)).toEqual({ final: false, nextLevel: 2 });
    expect(afterLeaveApproval(2, 2)).toEqual({ final: true });
    expect(afterLeaveApproval(2, 3)).toEqual({ final: false, nextLevel: 3 });
    expect(afterLeaveApproval(1, 0)).toEqual({ final: true });
  });

  it('notifies managers at level 1 and HR afterwards or for sensitive types', () => {
    expect(levelAudience(1, false)).toBe('TEAM');
    expect(levelAudience(1, true)).toBe('COMPANY');
    expect(levelAudience(2, false)).toBe('COMPANY');
  });
});

describe('single-level routing (overtime, corrections)', () => {
  it('covers the department, never the requester', () => {
    expect(canDecideSingle(manager, { employeeId: 'e-1', departmentId: 'eng' })).toBe(true);
    expect(canDecideSingle(manager, { employeeId: 'e-1', departmentId: 'ops' })).toBe(false);
    expect(canDecideSingle(manager, { employeeId: 'e-mgr', departmentId: 'eng' })).toBe(false);
    expect(canDecideSingle(hr, { employeeId: 'e-1', departmentId: null })).toBe(true);
  });
});
