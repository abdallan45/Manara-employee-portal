// Strings for the Saturday rotation (groups A and B take turns on Saturdays). `ar` must match `en`.
export const en = {
  title: 'Saturday rotation',
  groupNames: { A: 'A', B: 'B' },
  help:
    'Saturdays are part of the contract, but the team is split into groups A and B that take turns: group A works one Saturday, group B the next. A working Saturday is a normal workday. On their Saturday off nobody is marked absent, and if someone comes in, their hours are recorded but never count as overtime. Public holidays come first. Set each department\'s group on the Departments page; an employee can be given their own group.',
  startDate: 'Group A works first on',
  startHint: 'Must be a Saturday. Leave it empty to turn the rotation off; Saturdays then follow the schedules.',
  startInvalid: 'Choose a Saturday.',
  isOff: 'The rotation is off. Saturdays follow the schedules.',
  save: 'Save',
  turnOff: 'Turn off',
  saved: 'Saturday rotation saved.',
  turnedOff: 'Saturday rotation turned off.',
  preview: 'Next Saturdays',
  groupWorks: 'Group {group} works',
  group: 'Group {group}',
  beforeStart: 'Before the rotation starts',

  groupLabel: 'Saturday group',
  departmentHint: 'Employees of this department work every other Saturday, alternating with the other group. An employee can be given their own group in their profile.',
  noRotation: 'No rotation',
  employeeHint: 'Which Saturdays this employee works. By default they follow their department\'s group.',
  departmentDefault: 'Department default ({value})',
  noSaturdays: 'Doesn\'t work Saturdays',

  effective: 'Saturday group',
  nextWorking: 'Next working Saturday',
  notOnRotation: 'Not on the rotation',
  rotationNotSet: 'The Saturday rotation has not been set up.',

  offBadge: 'Saturday off (rota)',
  homeOffTitle: 'Your Saturday off',
  homeOffBody: 'If you come in today, your hours are recorded but not counted as overtime.',
};

export const ar: typeof en = {
  title: 'التناوب على أيام السبت',
  groupNames: { A: 'أ', B: 'ب' },
  help:
    'أيام السبت من أيام العقد، لكن الفريق مقسوم إلى مجموعتين (أ) و(ب) تتناوبان: تعمل المجموعة (أ) سبتًا والمجموعة (ب) السبت الذي يليه. سبت العمل يوم دوام عادي. وفي سبت العطلة لا يُسجَّل أحد غائبًا، ومن يحضر تُسجَّل ساعاته ولا تُحتسب عملًا إضافيًا. العطل الرسمية لها الأولوية. حدِّد مجموعة كل قسم من صفحة الأقسام، ويمكن تعيين مجموعة خاصة لأي موظف.',
  startDate: 'أول سبت تعمل فيه المجموعة (أ)',
  startHint: 'يجب أن يكون يوم سبت. اتركه فارغًا لإيقاف التناوب، فتتبع أيام السبت جداول الدوام.',
  startInvalid: 'اختر يوم سبت.',
  isOff: 'التناوب متوقف. أيام السبت تتبع جداول الدوام.',
  save: 'حفظ',
  turnOff: 'إيقاف',
  saved: 'تم حفظ التناوب على أيام السبت.',
  turnedOff: 'تم إيقاف التناوب على أيام السبت.',
  preview: 'أيام السبت القادمة',
  groupWorks: 'تعمل المجموعة ({group})',
  group: 'المجموعة ({group})',
  beforeStart: 'قبل بدء التناوب',

  groupLabel: 'مجموعة السبت',
  departmentHint: 'يعمل موظفو هذا القسم سبتًا ويرتاحون السبت الذي يليه، بالتناوب مع المجموعة الأخرى. ويمكن تعيين مجموعة خاصة لأي موظف من ملفه.',
  noRotation: 'بدون تناوب',
  employeeHint: 'أيّ أيام السبت يعمل فيها هذا الموظف. افتراضيًا يتبع مجموعة قسمه.',
  departmentDefault: 'حسب القسم ({value})',
  noSaturdays: 'لا يعمل أيام السبت',

  effective: 'مجموعة السبت',
  nextWorking: 'سبت العمل القادم',
  notOnRotation: 'خارج التناوب',
  rotationNotSet: 'لم يُضبط التناوب على أيام السبت بعد.',

  offBadge: 'سبت عطلة (تناوب)',
  homeOffTitle: 'اليوم سبت عطلتك',
  homeOffBody: 'إذا حضرت اليوم تُسجَّل ساعاتك، لكنها لا تُحتسب عملًا إضافيًا.',
};
