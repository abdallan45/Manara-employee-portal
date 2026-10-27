'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { SETTING_DEFAULTS, type ApprovalStep, type RoleDto, type SettingDto } from '@workforce/shared';

import { ChainEditor } from '@/components/approval-chain';
import { ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { settingsHref } from '@/lib/nav';
import { useApi } from '@/lib/use-api';

type ChainKey = 'approvals.overtimeSteps' | 'approvals.correctionSteps';

const valueOf = (settings: SettingDto[] | undefined, key: ChainKey): ApprovalStep[] => {
  const v = settings?.find((s) => s.key === key)?.value;
  return Array.isArray(v) && v.length ? (v as string[]) : SETTING_DEFAULTS[key];
};

/** Settings → Approval chains: the overtime and correction chains (leave types carry their own). */
export function ApprovalsTab() {
  const { t } = useI18n();
  const c = t.approvalChains.settings;
  const settings = useApi<SettingDto[]>('/settings');
  const roles = useApi<RoleDto[]>('/roles');

  if ((settings.error && !settings.data) || (roles.error && !roles.data)) {
    return <ErrorState compact error={settings.error ?? roles.error} onRetry={() => { void settings.refetch(); void roles.refetch(); }} />;
  }
  if (!settings.data || !roles.data) return <LoadingRows rows={4} />;
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {c.description}{' '}
        <Link href={settingsHref('leave-types')} className="text-link underline-offset-4 hover:underline">
          {c.leaveTypesLink}
        </Link>
      </p>
      <ChainCard settingKey="approvals.overtimeSteps" title={c.overtime} help={c.overtimeHelp} initial={valueOf(settings.data, 'approvals.overtimeSteps')} roles={roles.data} />
      <ChainCard settingKey="approvals.correctionSteps" title={c.corrections} help={c.correctionsHelp} initial={valueOf(settings.data, 'approvals.correctionSteps')} roles={roles.data} />
    </div>
  );
}

function ChainCard({ settingKey, title, help, initial, roles }: { settingKey: ChainKey; title: string; help: string; initial: ApprovalStep[]; roles: RoleDto[] }) {
  const { t, errorMessage } = useI18n();
  const [saved, setSaved] = useState(initial);
  const [steps, setSteps] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = steps.join() !== saved.join();
  const id = settingKey === 'approvals.overtimeSteps' ? 'chain-overtime' : 'chain-corrections';

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api<SettingDto>(`/settings/${encodeURIComponent(settingKey)}`, { method: 'PATCH', body: { value: steps } });
      setSaved(res.value as ApprovalStep[]);
      toast.success(t.approvalChains.settings.saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="py-4">
      <CardContent className="grid gap-4 px-4">
        <ChainEditor id={id} label={title} help={`${help}\n\n${t.approvalChains.editor.help}`} value={steps} onChange={setSteps} roles={roles} disabled={saving} error={error ?? undefined} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void save()} disabled={!dirty || saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {saving ? t.common.saving : t.common.save}
          </Button>
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setSteps(saved)} disabled={saving}>
              {t.common.cancel}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
