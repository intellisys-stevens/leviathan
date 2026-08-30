{{- define "miglens-attribution.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "miglens-attribution.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "miglens-attribution.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "miglens-attribution.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "miglens-attribution.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "miglens-attribution.selectorLabels" -}}
app.kubernetes.io/name: {{ include "miglens-attribution.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "miglens-attribution.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "miglens-attribution.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
