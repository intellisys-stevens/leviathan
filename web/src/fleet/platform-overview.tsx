import { Activity, ArrowRight, Cloud, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { PlatformObservation } from './types';

/* oxlint-disable next/no-html-link-for-pages -- This is a Vite SPA, not Next.js. */

function jetstreamSummary(platform: PlatformObservation | undefined) {
  const instances = platform?.instances ?? [];
  return {
    total: instances.length,
    running: instances.filter(
      ({ instance }) => instance.cloudState === 'active',
    ).length,
    agents: instances.filter(({ agent }) => agent.status === 'available')
      .length,
    gpus: instances.reduce(
      (total, { agent }) => total + (agent.snapshot?.gpus.length ?? 0),
      0,
    ),
  };
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0 bg-muted/35 px-3 py-2 text-center">
      <p className="font-mono text-base font-semibold text-foreground">
        {value}
      </p>
      <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

export function PlatformOverview({
  nidhogg,
  jetstream,
}: {
  nidhogg: PlatformObservation | undefined;
  jetstream: PlatformObservation | undefined;
}) {
  const summary = jetstreamSummary(jetstream);
  const inventoryStatus = jetstream?.inventory.status ?? 'unavailable';

  return (
    <section aria-labelledby="platforms-heading">
      <div className="mb-3">
        <h2 id="platforms-heading" className="text-sm font-semibold">
          Platforms
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Nidhogg and Jetstream remain independent, peer monitoring surfaces.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <a
          href={nidhogg?.platform.dashboardUrl ?? '/'}
          className="rounded-xl outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open Nidhogg dashboard"
        >
          <Card className="h-full transition-colors hover:bg-instance-hover">
            <CardHeader>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Server className="size-4" aria-hidden="true" />
                </span>
                <Badge variant="outline">Direct dashboard</Badge>
              </div>
              <CardTitle>Nidhogg</CardTitle>
              <CardDescription>
                Existing Coder-aware, single-host MIGLens dashboard.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border">
                <Metric label="Scope" value="Host" />
                <Metric label="Identity" value="Coder" />
                <Metric label="Mode" value="Direct" />
              </div>
            </CardContent>
            <CardFooter className="justify-between text-xs text-muted-foreground">
              <span>Open the unchanged local dashboard</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </CardFooter>
          </Card>
        </a>

        <a
          href="/fleet/jetstream"
          className="rounded-xl outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open Jetstream fleet dashboard"
        >
          <Card className="h-full transition-colors hover:bg-instance-hover">
            <CardHeader>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Cloud className="size-4" aria-hidden="true" />
                </span>
                <Badge
                  variant={
                    inventoryStatus === 'available'
                      ? 'default'
                      : inventoryStatus === 'stale'
                        ? 'secondary'
                        : 'destructive'
                  }
                >
                  Inventory {inventoryStatus}
                </Badge>
              </div>
              <CardTitle>
                {jetstream?.platform.displayName ?? 'Jetstream'}
              </CardTitle>
              <CardDescription>
                OpenStack inventory with per-instance MIGLens agent health.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border bg-border">
                <Metric label="Instances" value={summary.total} />
                <Metric label="Running" value={summary.running} />
                <Metric label="Agents" value={summary.agents} />
                <Metric label="GPUs" value={summary.gpus} />
              </div>
            </CardContent>
            <CardFooter className="justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Activity className="size-3.5" aria-hidden="true" /> Read-only
                fleet view
              </span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </CardFooter>
          </Card>
        </a>
      </div>
    </section>
  );
}
