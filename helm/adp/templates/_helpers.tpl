{{/*
Name helpers. Standard shape, kept because every other chart an operator has
seen uses it and surprising them here buys nothing.
*/}}
{{- define "adp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "adp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "adp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "adp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "adp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "adp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "adp.runnerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "adp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: runner
{{- end -}}

{{- define "adp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "adp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "adp.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "adp.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
The DSN the server connects with. External wins when set; otherwise the
bundled StatefulSet's service name, which only exists when it is enabled.

Rendering fails rather than defaulting when neither is available: a chart that
quietly pointed at a database that does not exist would produce a pod that
crash-loops with a connection error, which is a much worse way to learn this.
*/}}
{{- define "adp.databaseUrl" -}}
{{- if .Values.externalDatabase.url -}}
{{- .Values.externalDatabase.url -}}
{{- else if .Values.postgres.enabled -}}
{{- printf "postgres://%s:%s@%s-postgres:5432/%s" .Values.postgres.user .Values.postgres.password (include "adp.fullname" .) .Values.postgres.database -}}
{{- else -}}
{{- required "Set externalDatabase.url, or postgres.enabled=true for an evaluation database. ADP does not run without Postgres." "" -}}
{{- end -}}
{{- end -}}

{{- define "adp.publicUrl" -}}
{{- $scheme := ternary "https" "http" .Values.ingress.tls.enabled -}}
{{- printf "%s://%s" $scheme .Values.ingress.host -}}
{{- end -}}

{{- define "adp.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "adp.runnerImage" -}}
{{- printf "%s:%s" .Values.runner.image.repository (default .Chart.AppVersion .Values.runner.image.tag) -}}
{{- end -}}
