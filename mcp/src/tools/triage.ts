// One tool that sweeps the whole cluster and reports problems by severity.
// It reuses the building blocks from the other tool files.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { core, discovery, currentContext, ok, fail, age } from "../k8s.js";
import { podSummary } from "./cluster.js";
import { listApps, appSummary } from "./argocd.js";

type Finding = { severity: "critical" | "warning"; what: string; detail: string; nextStep: string };

export function registerTriageTool(server: McpServer) {
  server.registerTool(
    "triage_cluster",
    {
      description:
        "Sweep the cluster: nodes not Ready, failing or restarting pods, Services with no endpoints, and ArgoCD apps that are OutOfSync or unhealthy. Start here, then drill in with describe_pod, pod_logs or argocd_app_drift.",
      inputSchema: {},
    },
    async () => {
      try {
        const findings: Finding[] = [];

        // 1. Nodes. Also remember when each node last became Ready, to spot node restarts.
        const nodeReadySince = new Map<string, number>();
        for (const node of (await core.listNode()).items) {
          const ready = node.status?.conditions?.find((c) => c.type === "Ready");
          if (ready?.lastTransitionTime) nodeReadySince.set(node.metadata?.name ?? "", new Date(ready.lastTransitionTime).getTime());
          if (ready?.status !== "True") {
            findings.push({
              severity: "critical",
              what: `node/${node.metadata?.name}`,
              detail: `Ready=${ready?.status}: ${ready?.message ?? ""}`,
              nextStep: "Check the node container/VM is running.",
            });
          }
        }

        // 2. Pods
        const restartedWithNode = new Map<string, number>(); // node name -> pods that restarted when it came back
        for (const pod of (await core.listPodForAllNamespaces()).items) {
          const p = podSummary(pod);
          if (["Succeeded", "Completed"].includes(p.status)) continue; // finished jobs are fine
          const ref = `pod/${p.namespace}/${p.name}`;
          // When did a container in this pod last stop? Restart counts never reset,
          // so only a recent restart is worth reporting.
          const lastExit = (pod.status?.containerStatuses ?? [])
            .map((c) => c.lastState?.terminated?.finishedAt)
            .filter((d): d is Date => d !== undefined)
            .map((d) => new Date(d).getTime())
            .sort((a, b) => b - a)[0];
          const restartedRecently = lastExit !== undefined && Date.now() - lastExit < 60 * 60 * 1000; // last hour
          // Did the current container start within 10 minutes of its node coming back? Then the node restarted, not the app.
          const startedAt = (pod.status?.containerStatuses ?? [])
            .map((c) => c.state?.running?.startedAt)
            .filter((d): d is Date => d !== undefined)
            .map((d) => new Date(d).getTime())
            .sort((a, b) => b - a)[0];
          const nodeBack = nodeReadySince.get(p.node ?? "");
          const nodeRestart = startedAt !== undefined && nodeBack !== undefined && Math.abs(startedAt - nodeBack) < 10 * 60 * 1000;
          if (["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "Error", "OOMKilled", "CreateContainerConfigError"].includes(p.status)) {
            findings.push({
              severity: "critical",
              what: ref,
              detail: `${p.status}, restarts ${p.restarts}`,
              nextStep: p.status.includes("Image")
                ? "describe_pod: read the event message (not found / unauthorized / timeout)."
                : "pod_logs with previous=true, then describe_pod for the exit code.",
            });
          } else if (p.status === "Pending") {
            findings.push({ severity: "warning", what: ref, detail: "Pending", nextStep: "describe_pod: look for scheduling events." });
          } else if (p.ready.split("/")[0] !== p.ready.split("/")[1]) {
            findings.push({
              severity: "warning",
              what: ref,
              detail: `not ready (${p.ready}), status ${p.status}`,
              nextStep: "Readiness probe failing: describe_pod events, then check what the probe depends on.",
            });
          } else if (p.restarts > 0 && restartedRecently && nodeRestart) {
            restartedWithNode.set(p.node ?? "?", (restartedWithNode.get(p.node ?? "?") ?? 0) + 1); // summarised below
          } else if (p.restarts > 0 && restartedRecently) {
            findings.push({
              severity: "warning",
              what: ref,
              detail: `running but restarted ${p.restarts}x, last ${age(new Date(lastExit))} ago`,
              nextStep: "describe_pod lastState: exit code 137 = killed (liveness/OOM), 1 = app error.",
            });
          }
        }

        // One line per node instead of one per pod for restarts caused by the node coming back.
        for (const [node, count] of restartedWithNode) {
          findings.push({
            severity: "warning",
            what: `node/${node}`,
            detail: `${count} pods restarted together when this node came back ${age(new Date(nodeReadySince.get(node) ?? 0))} ago`,
            nextStep: "Expected after a node or cluster restart (for example a Codespace stop/start). No action unless it keeps happening.",
          });
        }

        // 3. Services with no ready endpoints
        const slices = (await discovery.listEndpointSliceForAllNamespaces()).items;
        for (const svc of (await core.listServiceForAllNamespaces()).items) {
          if (!svc.spec?.selector || Object.keys(svc.spec.selector).length === 0) continue;
          const n = slices
            .filter(
              (s) =>
                s.metadata?.namespace === svc.metadata?.namespace &&
                s.metadata?.labels?.["kubernetes.io/service-name"] === svc.metadata?.name,
            )
            .flatMap((s) => s.endpoints ?? [])
            .filter((e) => e.conditions?.ready !== false).length;
          if (n === 0) {
            findings.push({
              severity: "warning",
              what: `service/${svc.metadata?.namespace}/${svc.metadata?.name}`,
              detail: `0 ready endpoints for selector ${JSON.stringify(svc.spec.selector)}`,
              nextStep: "Compare the selector with the pods' labels (typo?) or fix the pods' readiness.",
            });
          }
        }

        // 4. ArgoCD (skipped quietly if ArgoCD isn't installed)
        try {
          for (const app of (await listApps()).map(appSummary)) {
            if (app.sync !== "Synced" || app.health !== "Healthy") {
              findings.push({
                severity: app.health === "Degraded" || app.sync === "Unknown" ? "critical" : "warning",
                what: `argocd-app/${app.name}`,
                detail: `${app.sync} / ${app.health}${app.conditions.length ? ` / ${app.conditions.join("; ")}` : ""}`,
                nextStep: "argocd_app_drift to see which resources differ from Git. Fix in kubeaid-config, not with kubectl.",
              });
            }
          }
        } catch {
          findings.push({ severity: "warning", what: "argocd", detail: "Could not read ArgoCD Applications", nextStep: "Is ArgoCD installed?" });
        }

        findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
        const header = `Context: ${currentContext()}. ${findings.filter((f) => f.severity === "critical").length} critical, ${findings.filter((f) => f.severity === "warning").length} warnings.`;
        return ok(findings.length ? `${header}\n${JSON.stringify(findings, null, 2)}` : `${header}\nNo problems found.`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}