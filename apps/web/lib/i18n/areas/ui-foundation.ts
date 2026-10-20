// Strings for the ui-foundation work package. `ar` must have exactly the same shape as `en`.
export const en = {
  /** BulkActionBar */
  selectedCount: '{n} selected',
  clearSelection: 'Clear selection',
  bulkActions: 'Bulk actions',
  /** DataTable selection */
  selectAll: 'Select all',
  selectRow: 'Select {name}',
  selectRowFallback: 'Select row',
  /** DataTable stale banner and result count */
  staleBanner: "Couldn't refresh. Showing data from {time}.",
  retry: 'Retry',
  resultCount: '{n} results',
  /** Dialog dirty guard */
  discardTitle: 'Discard changes?',
  discardBody: 'What you entered will be lost.',
  discardConfirm: 'Discard changes',
  keepEditing: 'Keep editing',
  /** FormField */
  required: '(required)',
  /** HelpTip button label */
  moreInfo: 'More info',
  /** FormErrorSummary */
  errorSummaryTitle: 'Please fix the following:',
  /** ForbiddenState */
  forbiddenTitle: "You don't have access to this page",
  forbiddenBody: 'Ask HR or your system administrator if you need access.',
  goTo: 'Go to {homeLabel}',
  /** DateRangePicker */
  last30: 'Last 30 days',
  /** LateBadge */
  lateMinutes: 'Late {n} min',
  /** Departments form: code format error */
  deptCodeInvalid: 'Use 2 to 32 characters: A-Z, 0-9, _ or -.',
};

export const ar: typeof en = {
  selectedCount: '{n} محدد',
  clearSelection: 'إلغاء التحديد',
  bulkActions: 'إجراءات جماعية',
  selectAll: 'تحديد الكل',
  selectRow: 'تحديد {name}',
  selectRowFallback: 'تحديد الصف',
  staleBanner: 'تعذّر التحديث. البيانات المعروضة من {time}.',
  retry: 'إعادة المحاولة',
  resultCount: '{n} نتيجة',
  discardTitle: 'تجاهل التغييرات؟',
  discardBody: 'سيضيع ما أدخلته.',
  discardConfirm: 'تجاهل التغييرات',
  keepEditing: 'متابعة التعديل',
  required: '(مطلوب)',
  moreInfo: 'توضيح',
  errorSummaryTitle: 'يرجى تصحيح ما يلي:',
  forbiddenTitle: 'ليست لديك صلاحية لهذه الصفحة',
  forbiddenBody: 'اطلب الصلاحية من الموارد البشرية أو مسؤول النظام إن احتجتها.',
  goTo: 'الانتقال إلى {homeLabel}',
  last30: 'آخر 30 يوماً',
  lateMinutes: 'متأخر {n} د',
  deptCodeInvalid: 'استخدم من 2 إلى 32 رمزاً: A-Z أو 0-9 أو _ أو -.',
};
