# kubeaid-lab-mcp

An MCP server that lets AI assistants (Claude Code and other MCP clients) diagnose
Kubernetes clusters managed the KubeAid way: GitOps with ArgoCD, app-of-apps, Sealed Secrets.

Built in TypeScript with the official MCP SDK and Kubernetes client, while learning
Kubernetes and KubeAid from scratch on a k3d lab cluster.

## What it does

| Tool | Purpose |
| --- | --- |
| `triage_cluster` | One sweep: failing pods, restarts, Services with no endpoints, ArgoCD drift; ranked by severity with a next step |
| `describe_pod`, `pod_logs` | Root cause: last state, exit code, events, logs of the crashed container |
| `find_orphan_services` | Services whose selector matches no ready pods |
| `list_argocd_apps`, `argocd_app_drift` | Sync and health per app; which resources differ from Git |
| `sync_argocd_app` | Sync an app to Git (write, gated) |

Prompt `triage` encodes KubeAid habits: fix in the config repo, never sync without showing the drift.

## Safety

Read-only by default. `KUBEAID_MCP_ALLOW_WRITES=true` enables writes;
`KUBEAID_MCP_PROTECTED_CONTEXTS=prod-a,prod-b` refuses writes on those clusters even then.

## Quick start

```bash
cd mcp && npm install && npm run build
claude mcp add --transport stdio kubeaid -- node "$(pwd)/dist/index.js"
```


## How it works

<your architecture image from the guide, or a short description: Claude Code ->
stdio JSON-RPC -> kubeaid-mcp -> Kubernetes API (core, discovery, ArgoCD CRD)>

## Lab it was tested on

k3d cluster; notes-api (TypeScript + Postgres) deployed by ArgoCD from `kubeaid-config/`;
Sealed Secrets via a Helm chart Application; four planted bugs in `k8s/bugs.yaml`.

## Credits

Inspired by [KubeAid](https://github.com/Obmondo/kubeaid) by Obmondo and the
existing community kubeaid-mcp project.
