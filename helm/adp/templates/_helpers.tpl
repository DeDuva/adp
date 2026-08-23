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

{{- /*
Default image tags are the chart's appVersion with a "v" prefix, because that is
the tag release.yml actually publishes: it pushes ghcr.io/deduva/adp:${github.ref_name},
and the ref name of a version tag is "v0.5.0", not "0.5.0". Rendering the bare
appVersion produced a reference to an image that has never existed at any version —
a default `helm install` went straight to ImagePullBackOff.

An explicit .Values.image.tag is used verbatim: an operator pinning a digest or a
branch build is naming a real tag and must not have a "v" stapled onto it.
*/ -}}
{{- define "adp.image" -}}
{{- printf "%s:%s" .Values.image.repository (default (printf "v%s" .Chart.AppVersion) .Values.image.tag) -}}
{{- end -}}

{{- define "adp.runnerImage" -}}
{{- printf "%s:%s" .Values.runner.image.repository (default (printf "v%s" .Chart.AppVersion) .Values.runner.image.tag) -}}
{{- end -}}
