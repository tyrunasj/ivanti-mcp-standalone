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
  Whether the NetworkPolicy renders: "true" or "false". `auto` means exactly when
  authMode is none — the one mode where nothing else stands in front of the pod.
*/}}
{{- define "ivanti-mcp.networkPolicyEnabled" -}}
{{- $v := toString .Values.networkPolicy.enabled -}}
{{- if eq $v "auto" -}}
{{- eq .Values.server.authMode "none" -}}
{{- else if or (eq $v "true") (eq $v "false") -}}
{{- $v -}}
{{- else -}}
{{- fail (printf "networkPolicy.enabled must be auto, true or false (got %q)." $v) -}}
{{- end -}}
{{- end -}}

{{/*
  A URL the server will only fetch over TLS. Plain http is refused except to
  loopback — which in a pod means a sidecar, the one case it can be right.
  Called with (list "<value name>" <url>); empty passes, other guards own "required".
*/}}
{{- define "ivanti-mcp.requireHttps" -}}
{{- $name := index . 0 -}}
{{- $url := index . 1 | default "" | toString -}}
{{- if and $url (not (regexMatch "^https://" $url)) (not (regexMatch "^http://(localhost|127\\.[0-9]+\\.[0-9]+\\.[0-9]+|\\[::1\\])(:[0-9]+)?(/|$)" $url)) -}}
{{- fail (printf "%s must be an https:// URL (got %q). The server refuses plain http to anything but loopback: anyone on the path could read the API key, or swap the keys every token is verified against." $name $url) -}}
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
{{- if not (has .Values.server.authMode (list "none" "bearer" "oauth")) -}}
{{- fail (printf "server.authMode must be none, bearer or oauth (got %q)." (toString .Values.server.authMode)) -}}
{{- end -}}
{{- if not (has .Values.server.mode (list "full" "enduser")) -}}
{{- fail (printf "server.mode must be full or enduser (got %q)." (toString .Values.server.mode)) -}}
{{- end -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- fail "replicaCount must be 1. HTTP sessions are held in memory, one server per Mcp-Session-Id, and the pod that answers `initialize` mints the id — so the request that opens a session carries nothing a load balancer can route back by, and a second pod answers part of every conversation with \"unknown session\". See docs/deployment.md, Kubernetes." -}}
{{- end -}}
{{- if (.Values.sessionAffinity | default dict).enabled -}}
{{- fail "sessionAffinity is gone: hashing on Mcp-Session-Id cannot route a session back to the pod that created it, because `initialize` carries no id yet. Remove it; the chart runs one replica. See docs/deployment.md, Kubernetes." -}}
{{- end -}}
{{- if eq .Values.server.mode "enduser" -}}
{{- if not .Values.server.enduser.businessObjects -}}
{{- fail "server.mode=enduser needs server.enduser.businessObjects. Empty is a gate that allows nothing, which is fail-closed but almost certainly not what you meant." -}}
{{- end -}}
{{- else -}}
{{- with .Values.server.enduser -}}
{{- if or .businessObjects .quickActions .role -}}
{{- fail "server.enduser.* applies to mode=enduser only. In a full deployment it would be a gate that gates nothing — the server refuses ENDUSER_* settings under MCP_MODE=full for the same reason. Remove them, or set server.mode=enduser." -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- include "ivanti-mcp.requireHttps" (list "ivanti.baseUrl" .Values.ivanti.baseUrl) -}}
{{- include "ivanti-mcp.requireHttps" (list "ivanti.configUrl" .Values.ivanti.configUrl) -}}
{{- if eq .Values.server.authMode "oauth" -}}
{{- include "ivanti-mcp.requireHttps" (list "oauth.issuer" .Values.oauth.issuer) -}}
{{- include "ivanti-mcp.requireHttps" (list "oauth.jwksUri" .Values.oauth.jwksUri) -}}
{{- end -}}
{{- if eq .Values.server.authMode "oauth" -}}
{{- if not .Values.oauth.issuer -}}
{{- fail "server.authMode=oauth needs oauth.issuer." -}}
{{- end -}}
{{- end -}}
{{- if and .Values.ivanti.configUrl (not .Values.secrets.existingSecret) (not .Values.secrets.centralConfigApiKey) -}}
{{- fail "ivanti.configUrl needs the ConfigDB key: set secrets.centralConfigApiKey, or provide it in secrets.existingSecret under the key ivanti-central-config-api-key." -}}
{{- end -}}
{{- if and .Values.ivanti.impersonationRole (eq .Values.server.mode "enduser") -}}
{{- fail "ivanti.impersonationRole applies to server.mode=full; an enduser deployment opens the role server.enduser.role names." -}}
{{- end -}}
{{- if and (eq .Values.server.authMode "bearer") (not .Values.secrets.existingSecret) (not .Values.secrets.bearerToken) -}}
{{- fail "server.authMode=bearer needs a bearer token: set secrets.bearerToken, or provide it in secrets.existingSecret under the key bearer-token." -}}
{{- end -}}
{{- if and (eq .Values.server.authMode "bearer") (not .Values.secrets.existingSecret) .Values.secrets.bearerToken (lt (len (toString .Values.secrets.bearerToken)) 32) -}}
{{- fail "secrets.bearerToken must be at least 32 characters — the server refuses a shorter one. Generate it: openssl rand -hex 32" -}}
{{- end -}}
{{- if eq .Values.server.authMode "none" -}}
{{- if .Values.ingress.enabled -}}
{{- fail "server.authMode=none with an ingress publishes the entire tool surface unauthenticated. If that is genuinely intended, put the authentication in front of it and leave the ingress off here." -}}
{{- end -}}
{{- if has .Values.service.type (list "LoadBalancer" "NodePort") -}}
{{- fail (printf "server.authMode=none with service.type=%s publishes the entire tool surface unauthenticated beyond the cluster, just as an ingress would. Keep service.type=ClusterIP, or choose bearer or oauth." .Values.service.type) -}}
{{- end -}}
{{- end -}}
{{- $_ := include "ivanti-mcp.networkPolicyEnabled" . -}}
{{- end -}}
