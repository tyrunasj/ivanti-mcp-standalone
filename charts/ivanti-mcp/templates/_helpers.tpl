{{- define "ivanti-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Resource name. A release whose name already carries the chart name is used as-is,
so `helm install ivanti-mcp` yields `ivanti-mcp` rather than `ivanti-mcp-ivanti-mcp`
and `ivanti-mcp-selfservice` stays itself — one release is one audience, and the
audience belongs in the release name. Anything else is prefixed as usual.
*/}}
{{- define "ivanti-mcp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "ivanti-mcp.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ivanti-mcp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "ivanti-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ivanti-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ivanti-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ivanti-mcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ivanti-mcp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "ivanti-mcp.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "ivanti-mcp.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
  Refusals, evaluated before anything renders.

  The server itself fails closed and exits 78 on an incomplete configuration. Doing
  the same here moves the failure from a pod crash-looping at 03:00 to `helm install`
  answering immediately — which is the whole point of a chart having opinions.
*/}}
{{- define "ivanti-mcp.validate" -}}
{{- if not .Values.server.publicUrl -}}
{{- fail "server.publicUrl is required: it is matched verbatim against the OAuth token audience and the RFC 9728 metadata document, and is never derived from the request." -}}
{{- end -}}
{{- if hasSuffix "/" .Values.server.publicUrl -}}
{{- fail "server.publicUrl must not end with a trailing slash — the resource identifier is compared verbatim, and a stray slash surfaces as a client bug." -}}
{{- end -}}
{{- if not .Values.server.trustedOrigins -}}
{{- fail "server.trustedOrigins is required: origin validation is mandatory on every HTTP mode and is what stops DNS rebinding." -}}
{{- end -}}
{{- if not .Values.ivanti.baseUrl -}}
{{- fail "ivanti.baseUrl is required." -}}
{{- end -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.create) -}}
{{- fail "Set secrets.existingSecret (recommended), or secrets.create=true with secrets.ivantiApiKey for development." -}}
{{- end -}}
{{- if and .Values.secrets.create (not .Values.secrets.ivantiApiKey) -}}
{{- fail "secrets.create=true needs secrets.ivantiApiKey." -}}
{{- end -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- if not .Values.sessionAffinity.enabled -}}
{{- fail "replicaCount > 1 needs sessionAffinity.enabled=true. HTTP sessions are held in memory, one server per Mcp-Session-Id, so a request routed to another pod is answered as an unknown session. Enable affinity (and make sure your ingress honours the hash annotation) or stay at one replica." -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.server.mode "enduser" -}}
{{- if not .Values.server.enduser.businessObjects -}}
{{- fail "server.mode=enduser needs server.enduser.businessObjects. Empty is a gate that allows nothing, which is fail-closed but almost certainly not what you meant." -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.server.authMode "oauth" -}}
{{- if not .Values.oauth.issuer -}}
{{- fail "server.authMode=oauth needs oauth.issuer." -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.server.authMode "bearer") (not .Values.secrets.existingSecret) (not .Values.secrets.bearerToken) -}}
{{- fail "server.authMode=bearer needs a bearer token: set secrets.bearerToken, or provide it in secrets.existingSecret under the key bearer-token." -}}
{{- end -}}
{{- if eq .Values.server.authMode "none" -}}
{{- if .Values.ingress.enabled -}}
{{- fail "server.authMode=none with an ingress publishes the entire tool surface unauthenticated. If that is genuinely intended, put the authentication in front of it and leave the ingress off here." -}}
{{- end -}}
{{- end -}}
{{- end -}}
