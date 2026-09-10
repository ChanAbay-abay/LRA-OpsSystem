/**
 * LRA Global Ops :: /admin/settings
 *
 * The single `ops.settings` row (PRD.md §3.4/§5). Open to founder and
 * admin, matching `settings.ts`'s `requireAuthority('founder', 'admin')`
 * and `ops.settings`'s RLS update policy (`core.is_founder()`, which
 * already includes admin) — PRD.md names the founder as this screen's
 * owner; admin is added alongside per Chan's ask tonight, not in place
 * of the founder.
 *
 * Opening it to founders is what makes the read-only guard below
 * necessary. ERC and DCA hold `founder` authority with `read_only`
 * set, so they now reach this screen — correctly, since read-only means
 * "sees what oversight sees" — but `ops.settings`'s update policy is
 * `core.is_founder() and not core.is_read_only()`, so the form must not
 * offer them a Save the database will refuse. While this screen was
 * admin-only that case could not arise and there was no guard.
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
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { leaderboardVisibilityLabel } from '@/lib/labels';

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
  const { me } = useAuth();
  const readOnly = me?.readOnly ?? false;
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
      <PageHeader
        title="Ops settings"
        description="Recurring cap, staleness, reliability window, leaderboard visibility."
        help="admin-settings"
      />
      <ResourceView resource={resource} skeleton={<SkeletonRows rows={1} height={240} />}>
        {() =>
          settings ? (
            <>
              {/* A native `fieldset[disabled]` disables every control inside
                  it, Radix's Select trigger included, so the guard cannot be
                  missed off a field somebody adds later. */}
              <fieldset
                disabled={readOnly}
                className="grid max-w-xl grid-cols-2 gap-4 rounded-xl border border-hairline bg-surface p-5 disabled:opacity-60"
              >
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
              <SelectItem value="all">{leaderboardVisibilityLabel('all')}</SelectItem>
              <SelectItem value="oversight_only">{leaderboardVisibilityLabel('oversight_only')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Timezone">
          <Input value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} />
        </Field>
      </fieldset>
              <div className="mt-4">
                {readOnly ? (
                  <p className="text-body-sm text-ink-3">
                    Your account is read-only. These are the live values — they just can’t be changed from here.
                  </p>
                ) : (
                  <Button loading={saving} onClick={save}>
                    Save settings
                  </Button>
                )}
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
