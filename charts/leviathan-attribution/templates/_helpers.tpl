{{- define "leviathan-attribution.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "leviathan-attribution.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "leviathan-attribution.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "leviathan-attribution.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "leviathan-attribution.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "leviathan-attribution.selectorLabels" -}}
app.kubernetes.io/name: {{ include "leviathan-attribution.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "leviathan-attribution.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "leviathan-attribution.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
