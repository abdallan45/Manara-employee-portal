'use client';

import { Suspense, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, Pencil, Plus, Smile, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { MASCOT_LANGUAGES, PERMISSIONS, type BreakTypeDto, type MascotConfigDto, type MascotGroupDto, type MascotLanguage } from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { NouriaSvg } from '@/components/mascot/nouria-svg';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, ForbiddenState, LoadingRows } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { invalidateMascotConfig } from '@/lib/mascot/config';
import { useApi } from '@/lib/use-api';
import { useUrlTab } from '@/lib/use-url-state';

import { GroupEditorDialog } from './group-editor';
import { GroupDetail } from './group-detail';
import { conditionSummary, sortGroups } from './mascot-helpers';
import { GroupActiveSwitch, useDeleteGroup, type MascotStore } from './mascot-store';
import { TryItPanel } from './try-panel';

/** /admin/mascot: Nouria's lines and rules. ?group=<id> opens one group's lines; ?tab=try the "Try it" panel. */
export default function MascotAdminPage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.MASCOT_MANAGE)) return <ForbiddenState />;
  return (
    <Suspense fallback={<LoadingRows rows={6} />}>
      <MascotAdmin />
    </Suspense>
  );
}

function MascotAdmin() {
  const { t } = useI18n();
  const m = t.mascotAdmin;
  const params = useSearchParams();
  const groupId = params.get('group');
  const state = useApi<MascotConfigDto>('/mascot/config', { all: true });
  const breakTypes = useApi<BreakTypeDto[]>('/break-types', { includeInactive: true });
  const latestRef = useRef<MascotConfigDto | undefined>(undefined);
  latestRef.current = state.data;

  if (state.loading && !state.data) {
    return (
      <div className="space-y-6">
        <PageHeader title={m.title} description={m.subtitle} />
        <Card className="py-0">
          <LoadingRows rows={5} />
        </Card>
      </div>
    );
  }
  if (!state.data) {
    return (
      <div className="space-y-6">
        <PageHeader title={m.title} description={m.subtitle} />
        <Card className="py-0">
          <ErrorState error={state.error} onRetry={() => void state.refetch()} />
        </Card>
      </div>
    );
  }

  const store: MascotStore = {
    config: state.data,
    breakTypes: breakTypes.data,
    // Built on the latest copy (not this render's), so successive updates in one tick add up.
    update: (fn) => {
      const base = latestRef.current;
      if (!base) return;
      const next = fn(base);
      latestRef.current = next;
      state.setData(next);
      invalidateMascotConfig();
    },
    refetch: state.refetch,
  };

  if (groupId) return <GroupDetail key={groupId} groupId={groupId} store={store} />;
  return <Overview store={store} />;
}

function Overview({ store }: { store: MascotStore }) {
  const { t } = useI18n();
  const m = t.mascotAdmin;
  const [tab, setTab] = useUrlTab(['groups', 'try'], 'groups');
  const [editing, setEditing] = useState<MascotGroupDto | 'new' | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.title}
        description={m.subtitle}
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {m.groups.add}
          </Button>
        }
      />
      <EnabledCard store={store} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="groups">{m.tabs.groups}</TabsTrigger>
          <TabsTrigger value="try">{m.tabs.tryIt}</TabsTrigger>
        </TabsList>
        <TabsContent value="groups" className="mt-4">
          <GroupsList store={store} onEdit={setEditing} onAdd={() => setEditing('new')} />
        </TabsContent>
        <TabsContent value="try" className="mt-4">
          <TryItPanel store={store} />
        </TabsContent>
      </Tabs>

      <GroupEditorDialog store={store} editing={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function EnabledCard({ store }: { store: MascotStore }) {
  const { t, errorMessage } = useI18n();
  const m = t.mascotAdmin.enabled;
  const [saving, setSaving] = useState(false);
  const enabled = store.config.enabled;

  const toggle = async (next: boolean) => {
    setSaving(true);
    store.update((c) => ({ ...c, enabled: next }));
    try {
      await api<unknown>('/mascot/enabled', { method: 'PUT', body: { enabled: next } });
      toast.success(next ? m.savedOn : m.savedOff);
    } catch (err) {
      store.update((c) => ({ ...c, enabled: !next }));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex-row items-center gap-4 px-4 py-4 sm:px-6">
      <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-tint/[0.08] bg-tint/[0.04] p-1">
        <NouriaSvg mood={enabled ? 'happy' : 'sleepy'} compact />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-1">
          <span id="mascot-enabled-label" className="font-semibold">
            {m.title}
          </span>
          <HelpTip text={m.body} />
        </p>
        <p id="mascot-enabled-desc" className="sr-only">
          {m.body}
        </p>
        <p className="text-xs font-medium" aria-live="polite">
          {enabled ? m.on : m.off}
        </p>
        <LanguagePicker store={store} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {saving && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />}
        <Switch
          checked={enabled}
          onCheckedChange={(v) => void toggle(v)}
          disabled={saving}
          aria-labelledby="mascot-enabled-label"
          aria-describedby="mascot-enabled-desc"
        />
      </div>
    </Card>
  );
}

function LanguagePicker({ store }: { store: MascotStore }) {
  const { t, errorMessage } = useI18n();
  const m = t.mascotAdmin.enabled;
  const [saving, setSaving] = useState(false);
  const language = store.config.language;

  const change = async (next: MascotLanguage) => {
    const previous = language;
    setSaving(true);
    store.update((c) => ({ ...c, language: next }));
    try {
      await api<unknown>('/mascot/language', { method: 'PUT', body: { language: next } });
      invalidateMascotConfig();
      toast.success(fmt(m.languageSaved, { lang: m.languages[next] }));
    } catch (err) {
      store.update((c) => ({ ...c, language: previous }));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <span id="mascot-language-label" className="text-sm font-medium">{m.language}</span>
      <HelpTip text={m.languageHelp} />
      <Select value={language} onValueChange={(v) => void change(v as MascotLanguage)} disabled={saving}>
        <SelectTrigger className="h-9 w-auto min-w-44" aria-labelledby="mascot-language-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MASCOT_LANGUAGES.map((l) => (
            <SelectItem key={l} value={l}>{m.languages[l]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {saving && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />}
    </div>
  );
}

function LinesCount({ group }: { group: MascotGroupDto }) {
  const { t } = useI18n();
  const recorded = group.lines.filter((l) => l.audioUrl).length;
  return <span className="tabular whitespace-nowrap">{fmt(t.mascotAdmin.groups.linesCount, { n: group.lines.length, rec: recorded })}</span>;
}

function GroupsList({ store, onEdit, onAdd }: { store: MascotStore; onEdit: (g: MascotGroupDto) => void; onAdd: () => void }) {
  const { t, locale } = useI18n();
  const m = t.mascotAdmin;
  const rows = sortGroups(store.config.groups);
  const del = useDeleteGroup(store);
  const href = (g: MascotGroupDto) => `/admin/mascot?group=${encodeURIComponent(g.id)}`;

  const actions = (g: MascotGroupDto) => (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" size="icon-sm" onClick={() => onEdit(g)} aria-label={`${t.common.edit}: ${g.name}`}>
        <Pencil aria-hidden />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={() => del.ask(g)} aria-label={`${t.common.delete}: ${g.name}`}>
        <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
      </Button>
    </div>
  );

  const columns: Column<MascotGroupDto>[] = [
    {
      id: 'name',
      header: m.groups.name,
      cell: (g) => (
        <span className="grid gap-0.5">
          <span className="font-medium">{g.name}</span>
          {g.description && <span className="text-muted-foreground line-clamp-1 text-xs">{g.description}</span>}
        </span>
      ),
    },
    { id: 'trigger', header: m.groups.trigger, cell: (g) => <Badge variant="outline">{m.triggers[g.trigger]}</Badge> },
    { id: 'conditions', header: m.groups.conditions, cell: (g) => <span className="text-muted-foreground text-sm">{conditionSummary(g.conditions ?? {}, t, locale, store.breakTypes)}</span> },
    { id: 'priority', header: m.groups.priority, className: 'w-20', cell: (g) => <span className="tabular">{g.priority}</span> },
    { id: 'lines', header: m.groups.lines, cell: (g) => <LinesCount group={g} /> },
    { id: 'active', header: m.groups.active, className: 'w-20', cell: (g) => <GroupActiveSwitch group={g} store={store} /> },
    { id: 'actions', header: t.common.actions, srOnlyHeader: true, className: 'w-24 text-end', cell: actions },
  ];

  if (rows.length === 0) {
    return (
      <Card className="py-0">
        <EmptyState
          icon={Smile}
          title={m.groups.empty}
          description={m.groups.emptyBody}
          action={
            <Button onClick={onAdd}>
              <Plus aria-hidden />
              {m.groups.add}
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <>
      <Card className="gap-0 py-0">
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(g) => g.id}
          rowHref={href}
          emptyTitle={m.groups.empty}
          mobileCard={(g) => (
            <div className="grid min-w-0 gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{g.name}</span>
                {!g.isActive && <Badge variant="secondary">{m.groups.inactive}</Badge>}
              </div>
              <span className="text-xs font-medium">{m.triggers[g.trigger]}</span>
              <span className="text-muted-foreground text-xs">{conditionSummary(g.conditions ?? {}, t, locale, store.breakTypes)}</span>
              <span className="text-muted-foreground text-xs">
                {m.groups.priority}: <span className="tabular">{g.priority}</span> · <LinesCount group={g} />
              </span>
            </div>
          )}
          mobileActions={(g) => (
            <div className="flex items-center gap-1">
              <GroupActiveSwitch group={g} store={store} />
              {actions(g)}
            </div>
          )}
        />
      </Card>
      {del.dialog}
    </>
  );
}
