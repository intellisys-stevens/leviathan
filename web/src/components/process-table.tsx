import { memo, useDeferredValue, useMemo, useRef } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { processSearchText } from '../lib';
import { workloadLabel } from '../attribution';
import type { Attribution, Process, Snapshot } from '../types';
import { useMediaQuery } from '../use-media-query';

const desktopProcessQuery = '(min-width: 768px)';

const column = createColumnHelper<Process>();
const baseColumns = [
  column.accessor('pid', {
    header: 'PID',
    cell: (context) => (
      <span className="font-mono text-primary">{context.getValue()}</span>
    ),
  }),
  column.accessor((process) => process.user || '—', {
    id: 'user',
    header: 'User',
  }),
  column.accessor((process) => process.executable || '—', {
    id: 'executable',
    header: 'Executable',
    cell: (context) => (
      <span
        className="block max-w-[330px] truncate font-mono text-[13px]"
        title={context.getValue()}
      >
        {context.getValue()}
      </span>
    ),
  }),
  column.accessor((process) => process.commandLine || '—', {
    id: 'command',
    header: 'Command',
    cell: (context) => (
      <span className="block max-w-[420px] truncate" title={context.getValue()}>
        {context.getValue()}
      </span>
    ),
  }),
  column.accessor(formatProcessStart, { id: 'started', header: 'Started' }),
  column.accessor('status', {
    header: 'Status',
    cell: (context) => (
      <span
        className={
          context.getValue() === 'available'
            ? 'text-muted-foreground'
            : 'text-amber-700 dark:text-amber-300'
        }
      >
        {context.getValue()}
      </span>
    ),
  }),
];

type Props = {
  processes: Snapshot['processes'];
  procCapability: Snapshot['capabilities']['proc'];
  attribution?: Attribution;
  query: string;
  onQueryChange: (query: string) => void;
};

function formatProcessStart(process: Process): string {
  return process.startTime
    ? new Date(process.startTime).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
}

function processCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'process' : 'processes'}`;
}

function statusClassName(status: Process['status']): string {
  return status === 'available'
    ? 'text-muted-foreground'
    : 'text-amber-700 dark:text-amber-300';
}

function processWorkloadRef(process: Process): string | undefined {
  return process.workloadRef;
}

function processWorkload(
  process: Process,
  workloadsByRef: Map<string, Attribution['workloads'][number]>,
) {
  const reference = processWorkloadRef(process);
  return reference ? workloadsByRef.get(reference) : undefined;
}

function processWorkspaceLabel(
  process: Process,
  workloadsByRef: Map<string, Attribution['workloads'][number]>,
): string | undefined {
  const workload = processWorkload(process, workloadsByRef);
  return workload ? workloadLabel(workload) : undefined;
}

function ProcessCards({
  rows,
  attributionConfigured,
  workloadsByRef,
}: {
  rows: Process[];
  attributionConfigured: boolean;
  workloadsByRef: Map<string, Attribution['workloads'][number]>;
}) {
  return (
    <section
      id="process-results"
      aria-label="Host-wide GPU process cards"
      className="max-w-full overflow-x-hidden"
      data-testid="process-card-viewport"
    >
      <ul className="grid min-w-0 divide-y divide-border/70">
        {rows.map((process) => {
          const workspace = processWorkspaceLabel(process, workloadsByRef);
          return (
            <li
              key={`${process.pid}:${process.startTime || ''}`}
              className="min-w-0 p-3"
              data-testid="process-card"
            >
              <article className="min-w-0 overflow-hidden rounded-lg border border-border/75 bg-background/45">
                <div className="flex min-w-0 items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-primary">
                      PID {process.pid}
                    </p>
                    <p className="mt-0.5 truncate text-[13px] text-foreground">
                      {process.user || '—'}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-[13px] uppercase tracking-[0.08em] ${statusClassName(process.status)}`}
                    title={process.message}
                  >
                    {process.status}
                  </span>
                </div>

                <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t border-border/70 px-3 py-2.5 text-[13px]">
                  {attributionConfigured ? (
                    <div className="min-w-0">
                      <dt className="font-mono text-[13px] uppercase tracking-[0.08em] text-muted-foreground">
                        Workspace
                      </dt>
                      <dd className="mt-0.5 truncate" title={workspace}>
                        {workspace || '—'}
                      </dd>
                    </div>
                  ) : null}
                  <div className="min-w-0">
                    <dt className="font-mono text-[13px] uppercase tracking-[0.08em] text-muted-foreground">
                      Started
                    </dt>
                    <dd className="mt-0.5 font-mono text-[13px]">
                      {formatProcessStart(process)}
                    </dd>
                  </div>
                </dl>

                <details className="group border-t border-border/70">
                  <summary
                    className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[13px] font-medium outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
                    aria-label={`Show executable and command for PID ${process.pid}`}
                  >
                    Executable and command
                    <ChevronDown
                      className="motion-chevron size-3.5 shrink-0 text-muted-foreground group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>
                  <dl className="grid min-w-0 gap-3 border-t border-border/70 bg-muted/20 px-3 py-3 text-[13px]">
                    <div className="min-w-0">
                      <dt className="font-mono text-[13px] uppercase tracking-[0.08em] text-muted-foreground">
                        Executable
                      </dt>
                      <dd className="mt-1 min-w-0 break-all font-mono text-[13px]">
                        {process.executable || '—'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-mono text-[13px] uppercase tracking-[0.08em] text-muted-foreground">
                        Command
                      </dt>
                      <dd className="mt-1 min-w-0 break-all text-[13px]">
                        {process.commandLine || '—'}
                      </dd>
                    </div>
                    {process.message ? (
                      <div className="min-w-0">
                        <dt className="font-mono text-[13px] uppercase tracking-[0.08em] text-muted-foreground">
                          Status detail
                        </dt>
                        <dd className="mt-1 min-w-0 break-words text-[13px]">
                          {process.message}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </details>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProcessTableComponent({
  processes,
  procCapability,
  attribution,
  query,
  onQueryChange,
}: Props) {
  const desktopScrollViewportRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const desktop = useMediaQuery(desktopProcessQuery, true);
  const attributionConfigured = attribution != null;
  const workloadsByRef = useMemo(
    () =>
      new Map(
        (attribution?.workloads ?? []).map((workload) => [
          workload.ref,
          workload,
        ]),
      ),
    [attribution?.workloads],
  );
  const rows = useMemo(
    () =>
      deferredQuery
        ? processes.filter((process) =>
            processSearchText(
              process,
              processWorkspaceLabel(process, workloadsByRef),
            ).includes(deferredQuery),
          )
        : processes,
    [deferredQuery, processes, workloadsByRef],
  );
  const columns = useMemo(
    () =>
      attributionConfigured
        ? [
            ...baseColumns.slice(0, 2),
            column.accessor(
              (process) => {
                const workload = processWorkload(process, workloadsByRef);
                return workload ? workloadLabel(workload) : '—';
              },
              {
                id: 'workspace',
                header: 'Workspace',
                cell: (context) => (
                  <span
                    className="block max-w-[240px] truncate"
                    title={context.getValue()}
                  >
                    {context.getValue()}
                  </span>
                ),
              },
            ),
            ...baseColumns.slice(2),
          ]
        : baseColumns,
    [attributionConfigured, workloadsByRef],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (process) => `${process.pid}:${process.startTime || ''}`,
  });
  const resultLabel = deferredQuery
    ? `${rows.length} of ${processCountLabel(processes.length)}`
    : processCountLabel(rows.length);

  function changeQuery(nextQuery: string) {
    onQueryChange(nextQuery);
    if (desktopScrollViewportRef.current)
      desktopScrollViewportRef.current.scrollTop = 0;
  }

  return (
    <section
      className="frost-panel min-w-0 border border-border/75 bg-card/90"
      aria-labelledby="process-heading"
      data-testid="process-section"
    >
      <div className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row sm:items-end sm:justify-between">
        <h2
          id="process-heading"
          tabIndex={-1}
          className="scroll-mt-36 text-xl font-semibold tracking-[-0.018em] outline-none"
        >
          Processes
        </h2>
        <div className="w-full sm:w-[390px]">
          <div className="mb-1.5 flex min-h-6 items-center justify-between gap-3">
            <output
              className="font-mono text-[13px] text-muted-foreground"
              aria-live="polite"
            >
              {resultLabel}
            </output>
            {query.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => changeQuery('')}
                aria-label="Clear process filter"
              >
                Clear
              </Button>
            ) : null}
          </div>
          <label htmlFor="process-filter" className="relative block w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="process-filter"
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              className="pl-8 font-mono text-sm"
              placeholder="Filter processes"
              aria-label="Filter GPU processes"
              aria-controls="process-results"
            />
          </label>
        </div>
      </div>
      {rows.length === 0 ? (
        <div id="process-results" className="p-6 text-sm text-muted-foreground">
          {deferredQuery
            ? 'No GPU processes match this filter.'
            : procCapability.available
              ? 'No GPU-connected processes.'
              : procCapability.message ||
                'GPU-connected process detection is unavailable.'}
        </div>
      ) : desktop ? (
        <Table
          className={attributionConfigured ? 'min-w-[68rem]' : 'min-w-[58rem]'}
          containerClassName="max-h-[22rem] overflow-auto [scrollbar-gutter:stable] md:max-h-[24rem]"
          containerProps={{
            id: 'process-results',
            ref: desktopScrollViewportRef,
            role: 'region',
            tabIndex: 0,
            'aria-label': 'GPU processes table',
            'data-testid': 'process-scroll-viewport',
          }}
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="sticky top-0 z-10 border-b border-border bg-card text-[13px] uppercase tracking-[0.08em] text-muted-foreground"
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="text-sm">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <ProcessCards
          rows={rows}
          attributionConfigured={attributionConfigured}
          workloadsByRef={workloadsByRef}
        />
      )}
    </section>
  );
}

export const ProcessTable = memo(ProcessTableComponent);
