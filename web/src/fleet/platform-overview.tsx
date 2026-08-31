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
import { jetstreamPlatformPath } from './paths';

/* oxlint-disable next/no-html-link-for-pages -- This is a Vite SPA, not Next.js. */

function jetstreamSummary(platform: PlatformObservation | undefined) {
  const instances = platform?.instances ?? [];
  const running = instances.filter(
    ({ instance }) => instance.cloudState === 'active',
  );
  const monitored = running.filter(
    ({ agent }) => agent.status === 'available' && agent.snapshot != null,
  );
  const currentGPUObservations = monitored.filter(({ agent }) => {
    const nvml = agent.snapshot?.capabilities.nvml;
    return (
      agent.source !== 'exosphere_console' &&
      nvml?.available === true &&
      nvml.status === 'available'
    );
  });
  const knownGPUs = monitored.reduce(
    (total, { agent }) => total + (agent.snapshot?.gpus.length ?? 0),
    0,
  );
  const completeGPUCoverage = currentGPUObservations.length === running.length;
  return {
    total: instances.length,
    running: running.length,
    agents: monitored.length,
    gpus: completeGPUCoverage
      ? knownGPUs
      : knownGPUs > 0
        ? `≥${knownGPUs}`
        : 'Unknown',
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
          Choose a platform. Both dashboards use the same GPU and People
          organization.
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
                Coder-aware GPU, MIG, process, and workspace telemetry.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border">
                <Metric label="Platform" value="Host" />
                <Metric label="People" value="Coder" />
                <Metric label="Access" value="Direct" />
              </div>
            </CardContent>
            <CardFooter className="justify-between text-xs text-muted-foreground">
              <span>Open Nidhogg Dashboard</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </CardFooter>
          </Card>
        </a>

        <a
          href={jetstreamPlatformPath}
          className="rounded-xl outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open Jetstream dashboard"
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
                OpenStack instances with the same live GPU and People views.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border bg-border">
                <Metric label="Instances" value={summary.total} />
                <Metric label="Running" value={summary.running} />
                <Metric label="Monitored" value={summary.agents} />
                <Metric label="Known GPUs" value={summary.gpus} />
              </div>
            </CardContent>
            <CardFooter className="justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Activity className="size-3.5" aria-hidden="true" /> Open
                Jetstream Dashboard
              </span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </CardFooter>
          </Card>
        </a>
      </div>
    </section>
  );
}
