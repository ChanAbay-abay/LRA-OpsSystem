/**
 * LRA Global Ops :: /admin/settings
 *
 * The single `ops.settings` row (PRD.md §3.4/§5). Admin console per
 * Chan's ask tonight — admin is his operating seat, and `core.is_founder()`
 * already includes admin, so this PATCH is not a policy weakening.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api, ApiClientError } from '@/lib/api';

interface Settings {
  recurring_cap_pct: number;
  recurring_floor_points: number;
  stale_after_days: number;
  reliability_window_weeks: number;
  reliability_half_life_weeks: number;
  min_weeks_for_rating: number;
  leaderboard_visibility: 'all' | 'oversight_only';
  timezone: string;
}

export function AdminSettingsPage() {
  const resource = useResource((signal) => api.get<Settings>('/api/settings', { signal }), []);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (resource.status === 'ready' && resource.data) setSettings(resource.data);
  }, [resource.status, resource.data]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      await api.patch('/api/settings', {
        recurringCapPct: settings.recurring_cap_pct,
        recurringFloorPoints: settings.recurring_floor_points,
        staleAfterDays: settings.stale_after_days,
        reliabilityWindowWeeks: settings.reliability_window_weeks,
        reliabilityHalfLifeWeeks: settings.reliability_half_life_weeks,
        minWeeksForRating: settings.min_weeks_for_rating,
        leaderboardVisibility: settings.leaderboard_visibility,
        timezone: settings.timezone,
      });
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="Ops settings" description="Recurring cap, staleness, reliability window, leaderboard visibility." />
      <ResourceView resource={resource} skeleton={<SkeletonRows rows={1} height={240} />}>
        {() =>
          settings ? (
            <>
              <div className="grid max-w-xl grid-cols-2 gap-4 rounded-xl border border-hairline bg-surface p-5">
        <Field label="Recurring cap (0–1)">
          <Input
            type="number" step="0.01" min={0} max={0.99}
            value={settings.recurring_cap_pct}
            onChange={(e) => setSettings({ ...settings, recurring_cap_pct: Number(e.target.value) })}
          />
        </Field>
        <Field label="Recurring floor points">
          <Input
            type="number" min={0}
            value={settings.recurring_floor_points}
            onChange={(e) => setSettings({ ...settings, recurring_floor_points: Number(e.target.value) })}
          />
        </Field>
        <Field label="Stale after (days)">
          <Input
            type="number" min={1}
            value={settings.stale_after_days}
            onChange={(e) => setSettings({ ...settings, stale_after_days: Number(e.target.value) })}
          />
        </Field>
        <Field label="Reliability window (weeks)">
          <Input
            type="number" min={1}
            value={settings.reliability_window_weeks}
            onChange={(e) => setSettings({ ...settings, reliability_window_weeks: Number(e.target.value) })}
          />
        </Field>
        <Field label="Reliability half-life (weeks)">
          <Input
            type="number" step="0.1" min={0.1}
            value={settings.reliability_half_life_weeks}
            onChange={(e) => setSettings({ ...settings, reliability_half_life_weeks: Number(e.target.value) })}
          />
        </Field>
        <Field label="Min weeks for a rating">
          <Input
            type="number" min={0}
            value={settings.min_weeks_for_rating}
            onChange={(e) => setSettings({ ...settings, min_weeks_for_rating: Number(e.target.value) })}
          />
        </Field>
        <Field label="Leaderboard visibility">
          <Select
            value={settings.leaderboard_visibility}
            onValueChange={(v) => setSettings({ ...settings, leaderboard_visibility: v as Settings['leaderboard_visibility'] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              <SelectItem value="oversight_only">Oversight only</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Timezone">
          <Input value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} />
        </Field>
      </div>
              <div className="mt-4">
                <Button loading={saving} onClick={save}>
                  Save settings
                </Button>
              </div>
            </>
          ) : null
        }
      </ResourceView>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
