import {
  mascotConditionsMatch, selectMascotLine, type MascotContext, type MascotGroupDto, type MascotLineDto, type MascotTrigger,
} from '@workforce/shared';

const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const ctx = (over: Partial<MascotContext> = {}): MascotContext => ({ trigger: 'CHECK_IN', minuteOfDay: at('09:00'), weekday: 1, ...over });

let seq = 0;
function line(over: Partial<MascotLineDto> = {}): MascotLineDto {
  seq++;
  return {
    id: `l${seq}`, groupId: 'g', locale: 'ar', text: `line ${seq}`, mood: null, audioUrl: null, audioMime: null,
    isActive: true, sortOrder: 0, updatedAt: new Date(0).toISOString(), ...over,
  };
}
function group(over: Partial<MascotGroupDto> & { trigger?: MascotTrigger } = {}): MascotGroupDto {
  seq++;
  return {
    id: `g${seq}`, name: `group ${seq}`, description: null, trigger: 'CHECK_IN', conditions: {}, priority: 0,
    moods: [], isActive: true, sortOrder: 0, lines: [line()], ...over,
  };
}
const first = () => 0;

describe('mascotConditionsMatch', () => {
  it('empty conditions match anything', () => {
    expect(mascotConditionsMatch({}, ctx())).toBe(true);
  });

  it('time windows: from inclusive, to exclusive, and wrapping past midnight', () => {
    expect(mascotConditionsMatch({ timeTo: '12:00' }, ctx({ minuteOfDay: at('11:59') }))).toBe(true);
    expect(mascotConditionsMatch({ timeTo: '12:00' }, ctx({ minuteOfDay: at('12:00') }))).toBe(false);
    expect(mascotConditionsMatch({ timeFrom: '12:00' }, ctx({ minuteOfDay: at('12:00') }))).toBe(true);
    expect(mascotConditionsMatch({ timeFrom: '12:00' }, ctx({ minuteOfDay: at('11:00') }))).toBe(false);
    const night = { timeFrom: '22:00', timeTo: '05:00' };
    expect(mascotConditionsMatch(night, ctx({ minuteOfDay: at('23:30') }))).toBe(true);
    expect(mascotConditionsMatch(night, ctx({ minuteOfDay: at('02:00') }))).toBe(true);
    expect(mascotConditionsMatch(night, ctx({ minuteOfDay: at('05:00') }))).toBe(false);
    expect(mascotConditionsMatch(night, ctx({ minuteOfDay: at('12:00') }))).toBe(false);
  });

  it('weekdays; an empty list matches every day', () => {
    expect(mascotConditionsMatch({ weekdays: [4] }, ctx({ weekday: 4 }))).toBe(true);
    expect(mascotConditionsMatch({ weekdays: [4] }, ctx({ weekday: 3 }))).toBe(false);
    expect(mascotConditionsMatch({ weekdays: [] }, ctx({ weekday: 3 }))).toBe(true);
  });

  it('workday must be known and equal when set', () => {
    expect(mascotConditionsMatch({ workday: false }, ctx({ workday: false }))).toBe(true);
    expect(mascotConditionsMatch({ workday: false }, ctx({ workday: true }))).toBe(false);
    expect(mascotConditionsMatch({ workday: false }, ctx())).toBe(false);
    expect(mascotConditionsMatch({}, ctx({ workday: false }))).toBe(true);
  });

  it('arrival uses isLate and earlyBefore (default 08:00)', () => {
    expect(mascotConditionsMatch({ arrival: ['LATE'] }, ctx({ isLate: true, minuteOfDay: at('07:00') }))).toBe(true);
    expect(mascotConditionsMatch({ arrival: ['EARLY'] }, ctx({ minuteOfDay: at('07:59') }))).toBe(true);
    expect(mascotConditionsMatch({ arrival: ['EARLY'] }, ctx({ minuteOfDay: at('08:00') }))).toBe(false);
    expect(mascotConditionsMatch({ arrival: ['ON_TIME'] }, ctx({ minuteOfDay: at('08:00') }))).toBe(true);
    expect(mascotConditionsMatch({ arrival: ['EARLY'], earlyBefore: '07:30' }, ctx({ minuteOfDay: at('07:45') }))).toBe(false);
    expect(mascotConditionsMatch({ arrival: ['EARLY', 'ON_TIME'] }, ctx({ minuteOfDay: at('08:30') }))).toBe(true);
  });

  it('workVsRequired bounds are inclusive and need a value', () => {
    expect(mascotConditionsMatch({ workVsRequired: { min: 60 } }, ctx({ workMinusRequired: 60 }))).toBe(true);
    expect(mascotConditionsMatch({ workVsRequired: { min: 60 } }, ctx({ workMinusRequired: 59 }))).toBe(false);
    expect(mascotConditionsMatch({ workVsRequired: { max: -120 } }, ctx({ workMinusRequired: -120 }))).toBe(true);
    expect(mascotConditionsMatch({ workVsRequired: { max: -120 } }, ctx({ workMinusRequired: -119 }))).toBe(false);
    expect(mascotConditionsMatch({ workVsRequired: { min: -10, max: 10 } }, ctx({ workMinusRequired: 0 }))).toBe(true);
    expect(mascotConditionsMatch({ workVsRequired: { min: 60 } }, ctx())).toBe(false);
  });

  it('break type codes and exceeded flag', () => {
    expect(mascotConditionsMatch({ breakTypeCodes: ['LUNCH'] }, ctx({ breakTypeCode: 'LUNCH' }))).toBe(true);
    expect(mascotConditionsMatch({ breakTypeCodes: ['LUNCH'] }, ctx({ breakTypeCode: 'SHORT' }))).toBe(false);
    expect(mascotConditionsMatch({ breakTypeCodes: ['LUNCH'] }, ctx({ breakTypeCode: null }))).toBe(false);
    expect(mascotConditionsMatch({ breakExceeded: true }, ctx({ breakExceeded: true }))).toBe(true);
    expect(mascotConditionsMatch({ breakExceeded: true }, ctx())).toBe(false);
    expect(mascotConditionsMatch({ breakExceeded: false }, ctx())).toBe(true);
  });

  it('error codes', () => {
    expect(mascotConditionsMatch({ errorCodes: ['LOCATION_OUTSIDE_OFFICE'] }, ctx({ errorCode: 'LOCATION_OUTSIDE_OFFICE' }))).toBe(true);
    expect(mascotConditionsMatch({ errorCodes: ['LOCATION_OUTSIDE_OFFICE'] }, ctx({ errorCode: 'FORBIDDEN' }))).toBe(false);
    expect(mascotConditionsMatch({ errorCodes: ['LOCATION_OUTSIDE_OFFICE'] }, ctx())).toBe(false);
  });
});

describe('selectMascotLine', () => {
  it('only considers the trigger, highest priority first, then lower sortOrder', () => {
    const low = group({ priority: 0, sortOrder: 0 });
    const highB = group({ priority: 10, sortOrder: 2 });
    const highA = group({ priority: 10, sortOrder: 1 });
    const other = group({ trigger: 'POKE', priority: 99 });
    const pick = selectMascotLine({ groups: [low, highB, highA, other] }, ctx(), 'ar', { random: first });
    expect(pick?.group.id).toBe(highA.id);
  });

  it('skips groups whose conditions fail, inactive groups and groups without active lines', () => {
    const fallback = group({ priority: 0 });
    const groups = [
      group({ priority: 50, conditions: { workday: false } }),
      group({ priority: 40, isActive: false }),
      group({ priority: 30, lines: [line({ isActive: false })] }),
      fallback,
    ];
    expect(selectMascotLine({ groups }, ctx({ workday: true }), 'ar', { random: first })?.group.id).toBe(fallback.id);
  });

  it('never picks inactive lines', () => {
    const active = line();
    const g = group({ lines: [line({ isActive: false }), active, line({ isActive: false })] });
    for (const r of [0, 0.5, 0.99]) expect(selectMascotLine({ groups: [g] }, ctx(), 'ar', { random: () => r })?.line.id).toBe(active.id);
  });

  it('prefers the viewer locale and falls back to the other language', () => {
    const ar = line({ locale: 'ar' });
    const en = line({ locale: 'en' });
    expect(selectMascotLine({ groups: [group({ lines: [ar, en] })] }, ctx(), 'en', { random: first })?.line.id).toBe(en.id);
    expect(selectMascotLine({ groups: [group({ lines: [ar] })] }, ctx(), 'en', { random: first })?.line.id).toBe(ar.id);
  });

  it('avoids recently used lines unless nothing else is left', () => {
    const a = line();
    const b = line();
    const g = group({ lines: [a, b] });
    expect(selectMascotLine({ groups: [g] }, ctx(), 'ar', { random: first, avoid: [a.id] })?.line.id).toBe(b.id);
    expect(selectMascotLine({ groups: [g] }, ctx(), 'ar', { random: first, avoid: [a.id, b.id] })?.line.id).toBe(a.id);
  });

  it('mood: the line\'s own, else one of the group\'s, else happy', () => {
    expect(selectMascotLine({ groups: [group({ moods: ['sad'], lines: [line({ mood: 'party' })] })] }, ctx(), 'ar', { random: first })?.mood).toBe('party');
    expect(selectMascotLine({ groups: [group({ moods: ['sad', 'wink'] })] }, ctx(), 'ar', { random: () => 0.9 })?.mood).toBe('wink');
    expect(selectMascotLine({ groups: [group({ moods: [] })] }, ctx(), 'ar', { random: first })?.mood).toBe('happy');
  });

  it('returns null when nothing matches', () => {
    expect(selectMascotLine({ groups: [group({ trigger: 'POKE' })] }, ctx(), 'ar')).toBeNull();
    expect(selectMascotLine({ groups: [] }, ctx(), 'ar')).toBeNull();
  });
});
