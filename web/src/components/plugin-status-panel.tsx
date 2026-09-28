/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Capability tables need keyboard scrolling on narrow viewports. */
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePluginReport } from '../use-plugin-report';

function ObservationTime({ value }: { value?: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <>—</>;
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

export function PluginStatusPanel() {
  const { report, error, pending, refresh } = usePluginReport();
  return (
    <section
      className="frost-panel min-w-0 border border-border/75 bg-card/90"
      aria-labelledby="plugins-heading"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/70 p-4">
        <h2
          id="plugins-heading"
          className="text-xl font-semibold tracking-[-0.018em]"
        >
          Plugins
        </h2>
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={pending}
          aria-label="Refresh plugins"
        >
          <RefreshCw aria-hidden="true" /> {pending ? 'Refreshing' : 'Refresh'}
        </Button>
      </header>
      {error ? (
        <output className="block p-4 text-sm text-muted-foreground">
          {error}
          {report ? ' Showing the last report.' : ''}
        </output>
      ) : null}
      {!report && !error ? (
        <output className="block p-4 text-sm text-muted-foreground">
          Loading plugin status…
        </output>
      ) : null}
      {report?.plugins.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No plugins configured.
        </p>
      ) : null}
      {report?.plugins.length ? (
        <ul className="divide-y divide-border/70">
          {report.plugins.map((plugin) => (
            <li key={plugin.id} className="min-w-0 space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="break-all font-mono text-sm font-semibold">
                  {plugin.id}
                </h3>
                <span className="break-all text-sm text-muted-foreground">
                  {plugin.status}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Implementation</dt>
                  <dd className="break-all">
                    {plugin.implementation || 'External'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Transport</dt>
                  <dd>
                    {plugin.transport === 'builtin'
                      ? 'Built-in'
                      : 'Unix socket'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Poll interval</dt>
                  <dd>{plugin.intervalMs / 1_000} s</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Dependencies</dt>
                  <dd className="break-all">
                    {plugin.dependencies.join(', ') || 'None'}
                  </dd>
                </div>
              </dl>
              {plugin.message ? (
                <p className="break-words text-sm text-muted-foreground">
                  {plugin.message}
                </p>
              ) : null}
              {plugin.capabilities.length ? (
                <section
                  className="overflow-x-auto"
                  tabIndex={0}
                  aria-label={`${plugin.id} capabilities`}
                >
                  <table className="w-full text-left text-sm">
                    <thead className="text-muted-foreground">
                      <tr>
                        {[
                          'Capability',
                          'Status',
                          'Revision',
                          'Enabled',
                          'Observed',
                          'Last success',
                        ].map((label) => (
                          <th
                            key={label}
                            scope="col"
                            className="whitespace-nowrap px-2 py-2 font-medium first:pl-0"
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {plugin.capabilities.map((capability) => (
                        <tr
                          key={capability.capability}
                          className="border-t border-border/70"
                        >
                          <th
                            scope="row"
                            className="py-2 pr-2 font-mono font-normal"
                          >
                            {capability.capability}
                          </th>
                          <td className="px-2 py-2">
                            <span>{capability.status}</span>
                            {capability.message ? (
                              <p className="min-w-28 text-muted-foreground">
                                {capability.message}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-2 py-2">{capability.revision}</td>
                          <td className="px-2 py-2">
                            {capability.enabled ? 'Yes' : 'No'}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2">
                            <ObservationTime value={capability.observedAt} />
                          </td>
                          <td className="whitespace-nowrap px-2 py-2">
                            <ObservationTime value={capability.lastSuccess} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No capabilities reported.
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
