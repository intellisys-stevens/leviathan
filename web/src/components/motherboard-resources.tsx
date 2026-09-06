import { useRef, useState, type ReactNode } from 'react';
import { CircuitBoard, Cpu, Database, Info, MemoryStick } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { formatBytes, formatBytesPerSecond, formatPercent } from '../lib';
import type { Filesystem, Metric, Snapshot } from '../types';
import { HardwareBoardView } from './hardware-board-view';
import {
  buildMotherboardAppearance,
  type MotherboardCategoryId,
} from './motherboard-appearance';
import { MotherboardFallback } from './motherboard-fallback';
import { SnowCap } from './snow-cap';
import {
  busiestFilesystem,
  capacityPercent,
  combinedStatus,
  hostMetricValue,
  statusLabel,
  usable,
} from './system-overview';
import './motherboard-resources.css';

type Props = {
  snapshot: Snapshot;
  theme: 'dark' | 'light';
  live: boolean;
  selected: MotherboardCategoryId;
  onSelect: (category: MotherboardCategoryId) => void;
};

function validBytes(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function capacityReadable(filesystem: Filesystem): boolean {
  return (
    usable(filesystem.status) &&
    validBytes(filesystem.totalBytes) &&
    validBytes(filesystem.usedBytes) &&
    validBytes(filesystem.availableBytes) &&
    filesystem.totalBytes > 0 &&
    filesystem.usedBytes <= filesystem.totalBytes &&
    filesystem.availableBytes <= filesystem.totalBytes - filesystem.usedBytes
  );
}

function reservedBytes(
  capacity: Pick<Filesystem, 'totalBytes' | 'usedBytes' | 'availableBytes'>,
): number | null {
  const { totalBytes, usedBytes, availableBytes } = capacity;
  return validBytes(totalBytes) &&
    validBytes(usedBytes) &&
    validBytes(availableBytes) &&
    usedBytes + availableBytes <= totalBytes
    ? totalBytes - usedBytes - availableBytes
    : null;
}

function Status({
  status,
  measured = false,
}: {
  status: string;
  measured?: boolean;
}) {
  const label = statusLabel(status) ?? (measured ? 'Measured' : null);
  return label ? (
    <span className="motherboard-data-state" data-status={status}>
      {label}
    </span>
  ) : null;
}

function MetricValue({
  metric,
  live,
  domainStatus = 'available',
  kind = 'percent',
}: {
  metric: Metric;
  live: boolean;
  domainStatus?: string;
  kind?: 'percent' | 'load' | 'rate';
}) {
  const measurementStatus = combinedStatus(domainStatus, metric.status);
  const status = live ? measurementStatus : 'stale';
  const raw = usable(measurementStatus) ? hostMetricValue(metric) : null;
  const value =
    raw != null && raw >= 0 && (kind !== 'percent' || raw <= 100) ? raw : null;
  const formatted =
    value == null
      ? '—'
      : kind === 'rate'
        ? formatBytesPerSecond(value)
        : kind === 'load'
          ? value.toFixed(2)
          : formatPercent(value);
  return (
    <span className="motherboard-metric">
      <span>{formatted}</span>
      <Status
        status={value == null && usable(status) ? 'unavailable' : status}
      />
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function FilesystemRow({
  filesystem,
  live,
  highest,
}: {
  filesystem: Filesystem;
  live: boolean;
  highest: boolean;
}) {
  const readable = capacityReadable(filesystem);
  const percent = readable
    ? capacityPercent(filesystem.usedBytes, filesystem.totalBytes)
    : null;
  const reserved = readable ? reservedBytes(filesystem) : null;
  return (
    <li
      className="motherboard-filesystem"
      data-filesystem-id={filesystem.id}
      data-highest={highest || undefined}
    >
      <div className="motherboard-filesystem-heading">
        <h3>{filesystem.mountPoint}</h3>
        <span>{filesystem.fsType || 'Unknown type'}</span>
        {highest ? <span className="motherboard-fullest">Fullest</span> : null}
        <Status
          status={
            !live
              ? 'stale'
              : !readable && usable(filesystem.status)
                ? 'unavailable'
                : filesystem.status
          }
        />
        <span className="motherboard-filesystem-percent">
          {percent == null ? '—' : formatPercent(percent)}
        </span>
      </div>
      <dl className="motherboard-filesystem-facts">
        <Fact label="Used / total">
          {readable
            ? `${formatBytes(filesystem.usedBytes)} / ${formatBytes(filesystem.totalBytes)}`
            : '—'}
        </Fact>
        <Fact label="Available">
          {readable ? formatBytes(filesystem.availableBytes) : '—'}
        </Fact>
        {reserved != null && reserved > 0 ? (
          <Fact label="Reserved">{formatBytes(reserved)}</Fact>
        ) : null}
      </dl>
      <div className="motherboard-filesystem-usage">
        <Progress
          value={percent}
          aria-label={`${filesystem.mountPoint} space used`}
          aria-valuetext={
            percent == null
              ? 'Unavailable'
              : `${formatPercent(percent)} used${reserved ? '; reserved space excluded from available capacity' : ''}`
          }
        />
      </div>
    </li>
  );
}

/** The model is schematic; all reported resources remain readable in native HTML. */
export function MotherboardResources({
  snapshot,
  theme,
  live,
  selected,
  onSelect,
}: Props) {
  const { cpu, memory, storage } = snapshot.system;
  const [highlighted, setHighlighted] = useState<MotherboardCategoryId | null>(
    null,
  );
  const headings = useRef(new Map<MotherboardCategoryId, HTMLButtonElement>());
  const appearance = buildMotherboardAppearance(snapshot, live);
  const category = (id: string | null): MotherboardCategoryId | null =>
    id === 'cpu' || id === 'memory' || id === 'storage' ? id : null;
  const selectFromBoard = (id: string) => {
    const next = category(id);
    if (!next) return;
    onSelect(next);
    headings.current.get(next)?.focus({ preventScroll: true });
  };
  const readableFilesystems = storage.filesystems.filter(capacityReadable);
  const partial =
    readableFilesystems.length > 0 &&
    (readableFilesystems.length !== storage.filesystems.length ||
      !usable(storage.status));
  const estimated = readableFilesystems.some(
    (filesystem) => filesystem.status === 'estimated',
  );
  const storageStatus = !live
    ? 'stale'
    : partial
      ? 'partial'
      : readableFilesystems.length
        ? combinedStatus(
            storage.status,
            ...readableFilesystems.map((filesystem) => filesystem.status),
          )
        : usable(storage.status)
          ? 'unavailable'
          : storage.status;
  const totals = readableFilesystems.length
    ? {
        totalBytes: readableFilesystems.reduce(
          (sum, filesystem) => sum + filesystem.totalBytes!,
          0,
        ),
        usedBytes: readableFilesystems.reduce(
          (sum, filesystem) => sum + filesystem.usedBytes!,
          0,
        ),
        availableBytes: readableFilesystems.reduce(
          (sum, filesystem) => sum + filesystem.availableBytes!,
          0,
        ),
      }
    : null;
  const reserved = totals ? reservedBytes(totals) : null;
  const busiest = busiestFilesystem(readableFilesystems);
  const heading = (
    id: MotherboardCategoryId,
    label: string,
    icon: ReactNode,
    status: string,
  ) => (
    <div className="motherboard-category-heading">
      <h2>
        <button
          type="button"
          id={`resource-${id}`}
          className="motherboard-category-button"
          aria-pressed={selected === id}
          ref={(element) => {
            if (element) headings.current.set(id, element);
            else headings.current.delete(id);
          }}
          onClick={() => onSelect(id)}
          onFocus={() => setHighlighted(id)}
          onBlur={() => setHighlighted(null)}
          onMouseEnter={() => setHighlighted(id)}
          onMouseLeave={() => {
            if (document.activeElement !== headings.current.get(id))
              setHighlighted(null);
          }}
        >
          {icon}
          <span>{label}</span>
        </button>
      </h2>
      <Status status={status} measured />
    </div>
  );
  return (
    <section
      className="frost-panel motherboard-resources snow-capped"
      aria-label="Motherboard resources"
      data-testid="motherboard-resources"
      data-snow-cap="generated"
    >
      <SnowCap surfaceKey={`motherboard:${snapshot.host.hostname}`} />
      <header className="motherboard-panel-heading">
        <p>
          <CircuitBoard aria-hidden="true" />
          Motherboard
        </p>
        <details className="motherboard-about">
          <summary aria-label="About this motherboard illustration">
            <Info aria-hidden="true" />
          </summary>
          <p>
            A schematic of CPU, aggregate RAM, and mounted storage. Component
            placement and memory slots do not describe this host’s physical
            layout.
          </p>
        </details>
      </header>
      <div className="motherboard-layout">
        <div className="motherboard-scene">
          <HardwareBoardView
            sceneKey={`${snapshot.host.hostname}:motherboard`}
            topologyKey="motherboard-v1"
            scene={{ kind: 'motherboard', appearance }}
            theme={theme}
            selectedId={selected}
            highlightedId={highlighted}
            onHighlight={(id) => setHighlighted(category(id))}
            onSelect={selectFromBoard}
            label="Motherboard"
            fallback={
              <MotherboardFallback
                appearance={appearance}
                selectedId={selected}
                highlightedId={highlighted}
                theme={theme}
              />
            }
          />
        </div>
        <div className="motherboard-details">
          <section
            className="motherboard-category"
            aria-labelledby="resource-cpu"
            data-category="cpu"
            data-selected={selected === 'cpu'}
            data-highlighted={highlighted === 'cpu'}
          >
            {heading(
              'cpu',
              'CPU',
              <Cpu aria-hidden="true" />,
              live ? cpu.status : 'stale',
            )}
            <p className="motherboard-model-name">
              {cpu.model || 'CPU model unavailable'}
            </p>
            <dl className="motherboard-facts">
              <Fact label="Logical processors">
                {cpu.logicalProcessors > 0 ? cpu.logicalProcessors : '—'}
              </Fact>
              <Fact label="Architecture">{snapshot.host.arch || '—'}</Fact>
              <Fact label="Utilization">
                <MetricValue metric={cpu.utilization} live={live} />
              </Fact>
              <Fact label="Load · 1 / 5 / 15 min">
                <span className="motherboard-loads">
                  {[cpu.load1, cpu.load5, cpu.load15].map((metric, index) => (
                    <span
                      key={index}
                      aria-label={`${[1, 5, 15][index]} minute load`}
                    >
                      {index > 0 ? <span aria-hidden="true"> / </span> : null}
                      <MetricValue metric={metric} live={live} kind="load" />
                    </span>
                  ))}
                </span>
              </Fact>
            </dl>
          </section>
          <section
            className="motherboard-category"
            aria-labelledby="resource-memory"
            data-category="memory"
            data-selected={selected === 'memory'}
            data-highlighted={highlighted === 'memory'}
          >
            {heading(
              'memory',
              'RAM',
              <MemoryStick aria-hidden="true" />,
              live ? memory.status : 'stale',
            )}
            <dl className="motherboard-facts">
              <Fact label="Total">
                {validBytes(memory.totalBytes)
                  ? formatBytes(memory.totalBytes)
                  : '—'}
              </Fact>
              <Fact label="Used">
                {usable(memory.status) ? formatBytes(memory.usedBytes) : '—'}
              </Fact>
              <Fact label="Available">
                {usable(memory.status)
                  ? formatBytes(memory.availableBytes)
                  : '—'}
              </Fact>
              <Fact label="Memory used">
                <MetricValue
                  metric={memory.utilization}
                  live={live}
                  domainStatus={memory.status}
                />
              </Fact>
            </dl>
          </section>
          <section
            className="motherboard-category"
            aria-labelledby="resource-storage"
            data-category="storage"
            data-selected={selected === 'storage'}
            data-highlighted={highlighted === 'storage'}
          >
            {heading(
              'storage',
              'Storage',
              <Database aria-hidden="true" />,
              storageStatus,
            )}
            <dl className="motherboard-facts">
              <Fact label={partial ? 'Reported used / total' : 'Used / total'}>
                {totals
                  ? `${formatBytes(totals.usedBytes)} / ${formatBytes(totals.totalBytes)}`
                  : '—'}
                {partial && estimated ? <Status status="estimated" /> : null}
              </Fact>
              <Fact label="Available">
                {totals ? formatBytes(totals.availableBytes) : '—'}
                {reserved != null && reserved > 0 ? (
                  <span className="motherboard-reserved-total">
                    {' · '}
                    {formatBytes(reserved)} reserved
                  </span>
                ) : null}
              </Fact>
              <Fact label="Read / write">
                <span className="motherboard-storage-rates">
                  <span aria-label="Read">
                    <MetricValue
                      metric={storage.readBytesPerSecond}
                      live={live}
                      kind="rate"
                    />
                  </span>
                  <span aria-hidden="true"> / </span>
                  <span aria-label="Write">
                    <MetricValue
                      metric={storage.writeBytesPerSecond}
                      live={live}
                      kind="rate"
                    />
                  </span>
                </span>
              </Fact>
            </dl>
            {storage.filesystems.length ? (
              <ul
                className="motherboard-filesystems"
                aria-label="Mounted filesystem capacity"
              >
                {storage.filesystems.map((filesystem) => (
                  <FilesystemRow
                    key={filesystem.id}
                    filesystem={filesystem}
                    live={live}
                    highest={filesystem.id === busiest?.id}
                  />
                ))}
              </ul>
            ) : (
              <p className="motherboard-empty">
                No persistent local filesystem capacity is available.
              </p>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
