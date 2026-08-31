import { memo } from 'react';
import { AlertTriangle, CheckCircle2, CircleX } from 'lucide-react';
import { shortUUID } from '../lib';
import type { Diagnostic } from '../types';

type DiagnosticGroup = {
  diagnostic: Diagnostic;
  components: string[];
  details: string[];
};

export function groupDiagnostics(diagnostics: Diagnostic[]): DiagnosticGroup[] {
  const groups = new Map<string, DiagnosticGroup>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.status,
      diagnostic.summary,
      diagnostic.remedy || '',
    ].join('\u0000');
    const existing = groups.get(key);
    if (existing) {
      if (!existing.components.includes(diagnostic.component))
        existing.components.push(diagnostic.component);
      if (diagnostic.detail && !existing.details.includes(diagnostic.detail))
        existing.details.push(diagnostic.detail);
      continue;
    }
    groups.set(key, {
      diagnostic,
      components: [diagnostic.component],
      details: diagnostic.detail ? [diagnostic.detail] : [],
    });
  }
  return [...groups.values()];
}

function DiagnosticsPanelComponent({
  diagnostics,
}: {
  diagnostics: Diagnostic[];
}) {
  const groups = groupDiagnostics(diagnostics);
  return (
    <section
      className="frost-panel border border-border/75 bg-card/90"
      aria-labelledby="diagnostics-heading"
    >
      <div className="border-b border-border/70 p-4">
        <h2 id="diagnostics-heading" className="text-sm font-semibold">
          Diagnostics
        </h2>
        <p className="text-xs text-muted-foreground">
          Unavailable metrics and provider issues.
        </p>
      </div>
      {groups.length === 0 ? (
        <div className="flex items-center gap-2 p-4 text-sm text-primary">
          <CheckCircle2 className="size-4" /> No active diagnostics.
        </div>
      ) : (
        <ul className="divide-y divide-border/70">
          {groups.map(({ diagnostic, components, details }) => (
            <li
              key={`${diagnostic.code}-${diagnostic.status}-${diagnostic.summary}-${diagnostic.remedy || ''}`}
              className="flex gap-3 p-4"
            >
              {diagnostic.severity === 'error' ? (
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{diagnostic.summary}</p>
                  <span className="font-mono text-[10px] uppercase text-amber-700 dark:text-amber-300">
                    {diagnostic.status}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {components.length > 1
                    ? `${components.length} affected entities · ${components.map(shortUUID).join(', ')}`
                    : components[0]}
                  {details.length > 0 ? ` · ${details.join('; ')}` : ''}
                </p>
                {diagnostic.remedy ? (
                  <p className="mt-2 text-xs text-foreground/80">
                    Remedy: {diagnostic.remedy}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const DiagnosticsPanel = memo(DiagnosticsPanelComponent);
