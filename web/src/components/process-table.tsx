import { memo, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
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
import { processSearchText } from '../lib';
import { workloadLabel } from '../attribution';
import type { Attribution, Process, Snapshot } from '../types';

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
        className="block max-w-[330px] truncate font-mono text-[11px]"
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
  column.accessor(
    (process) =>
      process.startTime
        ? new Date(process.startTime).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
        : '—',
    { id: 'started', header: 'Started' },
  ),
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

function ProcessTableComponent({
  processes,
  procCapability,
  attribution,
}: {
  processes: Snapshot['processes'];
  procCapability: Snapshot['capabilities']['proc'];
  attribution?: Attribution;
}) {
  const [query, setQuery] = useState('');
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
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

  return (
    <section
      className="frost-panel min-w-0 border border-border/75 bg-card/90"
      aria-labelledby="process-heading"
      data-testid="process-section"
    >
      <div className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="process-heading" className="text-sm font-semibold">
          Host-wide GPU processes
        </h2>
        <label
          htmlFor="process-filter"
          className="relative block w-full sm:w-[390px]"
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="process-filter"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (scrollViewportRef.current) {
                scrollViewportRef.current.scrollTop = 0;
              }
            }}
            className="pl-8 font-mono text-xs"
            placeholder={
              attributionConfigured
                ? 'PID, user, executable, workspace'
                : 'PID, user, executable'
            }
            aria-label="Filter GPU processes"
          />
        </label>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground">
          {deferredQuery
            ? 'No GPU processes match this filter.'
            : procCapability.available
              ? 'No GPU-connected processes.'
              : procCapability.message ||
                'GPU-connected process detection is unavailable.'}
        </div>
      ) : (
        <Table
          className={attributionConfigured ? 'min-w-[68rem]' : 'min-w-[58rem]'}
          containerClassName="max-h-[22rem] overflow-auto [scrollbar-gutter:stable] md:max-h-[24rem]"
          containerProps={{
            ref: scrollViewportRef,
            role: 'region',
            tabIndex: 0,
            'aria-label': 'Host-wide GPU processes table',
            'data-testid': 'process-scroll-viewport',
          }}
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="sticky top-0 z-10 border-b border-border bg-card text-[10px] uppercase tracking-[0.11em] text-muted-foreground"
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
                  <TableCell key={cell.id} className="text-xs">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

export const ProcessTable = memo(ProcessTableComponent);
