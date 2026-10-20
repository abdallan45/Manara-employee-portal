'use client';

import { ChangePasswordForm } from '@/components/change-password-form';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n/context';

/**
 * Change your own password (POST /auth/me/password). Reached from the account menu; a session that must
 * change its password is kept on this route by components/password-change-guard, which renders the forced
 * variant itself.
 */
export default function ChangePasswordPage() {
  const { t } = useI18n();
  const s = t.accountSecurity;
  return (
    <div className="space-y-6">
      <PageHeader title={s.title} description={s.description} />
      <Card className="max-w-lg">
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
