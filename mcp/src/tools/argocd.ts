// Tools for ArgoCD Applications: the KubeAid-specific part.
// An Application is a custom resource (CRD), so we read it with the CustomObjects API,
// the same way `kubectl get applications -n argocd` does.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setHeaderOptions, PatchStrategy } from "@kubernetes/client-node";
import { z } from "zod";
import { custom, ARGOCD_NAMESPACE, assertWritable, currentContext, ok, fail } from "../k8s.js";


const APP = { group: "argoproj.io", version: "v1alpha1", plural: "applications" };

// The fields of an Application's .status that matter for triage.
type Application = {
  metadata: { name: string };
  spec: { source?: { repoURL?: string; path?: string; chart?: string; targetRevision?: string } };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string };
    conditions?: { type: string; message: string }[];
    operationState?: { phase?: string; message?: string; finishedAt?: string };
    resources?: { kind: string; namespace?: string; name: string; status?: string; health?: { status?: string } }[];
  };
};

export async function listApps(): Promise<Application[]> {
  const res = await custom.listNamespacedCustomObject({ ...APP, namespace: ARGOCD_NAMESPACE });
  return (res.items ?? []) as Application[];
}

export function appSummary(app: Application) {
  return {
    name: app.metadata.name,
    sync: app.status?.sync?.status ?? "Unknown", // Synced / OutOfSync / Unknown
    health: app.status?.health?.status ?? "Unknown", // Healthy / Progressing / Degraded / Missing
    source: app.spec.source?.chart
      ? `${app.spec.source.repoURL} chart ${app.spec.source.chart}@${app.spec.source.targetRevision}`
      : `${app.spec.source?.repoURL} path ${app.spec.source?.path}`,
    revision: app.status?.sync?.revision?.slice(0, 7),
    conditions: app.status?.conditions?.map((c) => `${c.type}: ${c.message}`) ?? [],
    lastSync: app.status?.operationState
      ? `${app.status.operationState.phase}: ${app.status.operationState.message ?? ""}`
      : "never synced",
  };
}

export function registerArgoTools(server: McpServer) {
  server.registerTool(
    "list_argocd_apps",
    {
      description:
        "List ArgoCD Applications with sync status (does the cluster match Git?), health, source, errors (conditions) and last sync result. In KubeAid, OutOfSync means drift or an unsynced Git change.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(JSON.stringify((await listApps()).map(appSummary), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "argocd_app_drift",
    {
      description:
        "For one ArgoCD Application, list exactly which resources are OutOfSync (differ from Git) or unhealthy. Use this to explain drift before anyone syncs.",
      inputSchema: { name: z.string().describe("Application name, e.g. notes") },
    },
    async ({ name }) => {
      try {
        const app = (await custom.getNamespacedCustomObject({ ...APP, namespace: ARGOCD_NAMESPACE, name })) as Application;
        const resources = app.status?.resources ?? [];
        const drifted = resources
          .filter((r) => r.status !== "Synced" || (r.health?.status && r.health.status !== "Healthy"))
          .map((r) => ({
            resource: `${r.kind}/${r.namespace ?? ""}/${r.name}`,
            sync: r.status,
            health: r.health?.status,
          }));
        return ok(
          JSON.stringify(
            {
              app: appSummary(app),
              driftedOrUnhealthy: drifted,
              advice:
                "KubeAid rule: Git is the source of truth. If the live change is wanted, commit it to kubeaid-config; otherwise sync to restore Git's version. Never fix drift with kubectl edits.",
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "sync_argocd_app",
    {
      description:
        "WRITE: ask ArgoCD to sync an Application to Git. Disabled unless the server runs with KUBEAID_MCP_ALLOW_WRITES=true, and refused on protected contexts. Always show the drift and get the user's OK first.",
      inputSchema: { name: z.string().describe("Application name, e.g. notes") },
    },
    async ({ name }) => {
      try {
        assertWritable();
        // Same patch you ran by hand in Block 3: set .operation.sync and ArgoCD carries it out.
        await custom.patchNamespacedCustomObject(
          {
            ...APP,
            namespace: ARGOCD_NAMESPACE,
            name,
            body: { operation: { initiatedBy: { username: "kubeaid-mcp" }, sync: {} } },
          },
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        );
        return ok(`Sync requested for "${name}" on context "${currentContext()}". Check list_argocd_apps in ~15s.`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}