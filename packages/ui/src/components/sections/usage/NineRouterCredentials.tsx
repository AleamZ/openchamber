import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

interface Status {
  configured: boolean;
  secretMasked?: string;
  servers?: Array<{ name: string; url: string }>;
}

interface ServerRow {
  name: string;
  url: string;
  password: string;
}

export const NineRouterCredentials: React.FC<{ providerName: string }> = ({ providerName }) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<Status | null>(null);
  const [rows, setRows] = React.useState<ServerRow[]>([{ name: '', url: '', password: '' }]);
  const [busy, setBusy] = React.useState(false);
  const route = '/api/quota/credentials/9router';

  React.useEffect(() => {
    void runtimeFetch(route)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const next: Status = await response.json();
        setStatus(next);
        setRows(
          next.servers && next.servers.length > 0
            ? next.servers.map((s) => ({ name: s.name, url: s.url, password: '' }))
            : [{ name: '', url: '', password: '' }]
        );
      })
      .catch(() => {
        setStatus({ configured: false });
        setRows([{ name: '', url: '', password: '' }]);
      });
  }, [route]);

  const request = async (
    path: string,
    method: string,
    body?: { servers: ServerRow[] }
  ) => {
    setBusy(true);
    try {
      const response = await runtimeFetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error);
      if (payload?.configured !== undefined) {
        setStatus(payload);
        setRows(
          payload.servers && payload.servers.length > 0
            ? payload.servers.map((s: { name: string; url: string }) => ({
                name: s.name,
                url: s.url,
                password: '',
              }))
            : [{ name: '', url: '', password: '' }]
        );
      }
      toast.success(t('settings.providers.page.quotaCredentials.saved', { provider: providerName }));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('settings.providers.page.openCodeGo.saveFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  const addServer = () => {
    if (rows.length >= 10) return;
    setRows((current) => [...current, { name: '', url: '', password: '' }]);
  };

  const removeRow = (index: number) => {
    if (rows.length <= 1) return;
    setRows((current) => current.filter((_, i) => i !== index));
  };

  const updateRow = (index: number, field: keyof ServerRow, value: string) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  };

  return (
    <div data-settings-item="usage.9router-credentials" className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{providerName}</h3>
      </div>
      <section className="space-y-3 px-2 pb-2 pt-0">
        <div className="space-y-1.5">
          <p className="typography-meta text-muted-foreground">
            {t('settings.providers.page.quotaCredentials.nineRouterInstructions')}
          </p>
          {status?.configured && (
            <p className="typography-meta text-muted-foreground">
              {t('settings.providers.page.quotaCredentials.nineRouterReenterPasswords')}
            </p>
          )}
        </div>

        <div className="hidden sm:grid sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,12rem)_auto] gap-2 typography-ui-label text-foreground">
          <span>{t('settings.providers.page.quotaCredentials.serverName')}</span>
          <span>{t('settings.providers.page.quotaCredentials.dashboardUrl')}</span>
          <span>{t('settings.providers.page.quotaCredentials.dashboardPassword')}</span>
          <span className="invisible">{t('settings.providers.page.quotaCredentials.removeServer')}</span>
        </div>

        <div className="space-y-2">
          {rows.map((row, index) => (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-center"
            >
              <label className="block typography-ui-label text-foreground">
                <span className="sm:hidden">{t('settings.providers.page.quotaCredentials.serverName')}</span>
                <Input
                  type="text"
                  className="h-7 text-xs sm:mt-0 mt-1"
                  placeholder={t('settings.providers.page.quotaCredentials.serverName')}
                  value={row.name}
                  onChange={(event) => updateRow(index, 'name', event.target.value)}
                  aria-label={t('settings.providers.page.quotaCredentials.serverName')}
                />
              </label>
              <label className="block typography-ui-label text-foreground">
                <span className="sm:hidden">{t('settings.providers.page.quotaCredentials.dashboardUrl')}</span>
                <Input
                  type="url"
                  className="h-7 font-mono text-xs sm:mt-0 mt-1"
                  placeholder="https://router.example.com"
                  value={row.url}
                  onChange={(event) => updateRow(index, 'url', event.target.value)}
                  aria-label={t('settings.providers.page.quotaCredentials.dashboardUrl')}
                />
              </label>
              <label className="block typography-ui-label text-foreground">
                <span className="sm:hidden">{t('settings.providers.page.quotaCredentials.dashboardPassword')}</span>
                <Input
                  type="password"
                  autoComplete="off"
                  className="h-7 font-mono text-xs sm:mt-0 mt-1"
                  placeholder={
                    status?.configured && status.secretMasked
                      ? status.secretMasked
                      : t('settings.providers.page.quotaCredentials.dashboardPassword')
                  }
                  value={row.password}
                  onChange={(event) => updateRow(index, 'password', event.target.value)}
                  aria-label={t('settings.providers.page.quotaCredentials.dashboardPassword')}
                />
              </label>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy || rows.length <= 1}
                onClick={() => removeRow(index)}
              >
                {t('settings.providers.page.quotaCredentials.removeServer')}
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy || rows.length >= 10}
            onClick={addServer}
          >
            {t('settings.providers.page.quotaCredentials.addServer')}
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={busy}
            onClick={() => request(route, 'PUT', { servers: rows })}
          >
            {status?.configured
              ? t('settings.providers.page.openCodeGo.replace')
              : t('settings.providers.page.openCodeGo.save')}
          </Button>
          {status?.configured && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => request(`${route}/validate`, 'POST')}
            >
              {t('settings.providers.page.openCodeGo.validate')}
            </Button>
          )}
          {status?.configured && (
            <Button
              type="button"
              variant="destructive"
              size="xs"
              disabled={busy}
              onClick={() => request(route, 'DELETE')}
            >
              {t('settings.providers.page.openCodeGo.delete')}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
};
