// Read-only tools for plain Kubernetes objects: contexts, pods, logs, events, services.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { V1Pod } from "@kubernetes/client-node";
import { z } from "zod";
import { kc, core, discovery, currentContext, ok, fail, age } from "../k8s.js";

// The status kubectl shows in its STATUS column: a waiting reason
// (CrashLoopBackOff, ImagePullBackOff...) beats the pod's phase (Running, Pending...).
export function podStatus(pod: V1Pod): string {
  if (pod.metadata?.deletionTimestamp) return "Terminating";
  for (const cs of pod.status?.containerStatuses ?? []) {
    if (cs.state?.waiting?.reason) return cs.state.waiting.reason;
    if (cs.state?.terminated?.reason) return cs.state.terminated.reason;
  }
  return pod.status?.phase ?? "Unknown";
}

export function podSummary(pod: V1Pod) {
  const cs = pod.status?.containerStatuses ?? [];
  return {
    namespace: pod.metadata?.namespace,
    name: pod.metadata?.name,
    ready: `${cs.filter((c) => c.ready).length}/${pod.spec?.containers.length ?? 0}`,
    status: podStatus(pod),
    restarts: cs.reduce((n, c) => n + c.restartCount, 0),
    node: pod.spec?.nodeName,
    age: age(pod.metadata?.creationTimestamp),
  };
}

export function registerClusterTools(server: McpServer) {
  server.registerTool(
    "list_contexts",
    {
      description: "List the kubeconfig contexts (clusters) and show which one this server is using.",
      inputSchema: {},
    },
    async () => {
      const lines = kc.getContexts().map((c) => `${c.name === currentContext() ? "* " : "  "}${c.name}`);
      return ok(`Contexts (* = in use):\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "list_pods",
    {
      description:
        "List pods with ready count, status, restarts and age, like `kubectl get pods`. Omit namespace for all namespaces.",
      inputSchema: { namespace: z.string().optional().describe("Namespace; omit for all") },
    },
    async ({ namespace }) => {
      try {
        const list = namespace
          ? await core.listNamespacedPod({ namespace })
          : await core.listPodForAllNamespaces();
        return ok(JSON.stringify(list.items.map(podSummary), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "describe_pod",
    {
      description:
        "Explain one pod: each container's current and last state (reason, exit code), plus the pod's recent events. Use this to find out WHY a pod is failing.",
      inputSchema: { namespace: z.string(), name: z.string() },
    },
    async ({ namespace, name }) => {
      try {
        const pod = await core.readNamespacedPod({ namespace, name });
        const containers = (pod.status?.containerStatuses ?? []).map((c) => ({
          name: c.name,
          image: c.image,
          ready: c.ready,
          restarts: c.restartCount,
          state: c.state,
          lastState: c.lastState, // exit code 137 = killed, 1 = app error
        }));
        const events = await core.listNamespacedEvent({
          namespace,
          fieldSelector: `involvedObject.name=${name}`,
        });
        const evts = events.items.map((e) => `${e.type} ${e.reason} (x${e.count ?? 1}): ${e.message}`);
        return ok(
          JSON.stringify({ summary: podSummary(pod), node: pod.spec?.nodeName, containers, events: evts }, null, 2),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "pod_logs",
    {
      description:
        "Get a pod's logs. Set previous=true to read the logs of the container that crashed before the current one.",
      inputSchema: {
        namespace: z.string(),
        name: z.string(),
        container: z.string().optional().describe("Needed only if the pod has several containers"),
        previous: z.boolean().optional().describe("Logs from the previous (crashed) container"),
        tailLines: z.number().int().positive().max(500).optional().describe("Last N lines (default 50)"),
      },
    },
    async ({ namespace, name, container, previous, tailLines }) => {
      try {
        const logs = await core.readNamespacedPodLog({
          namespace,
          name,
          container,
          previous,
          tailLines: tailLines ?? 50,
        });
        if (logs.startsWith("unable to retrieve container logs")) {
          return fail(new Error(`${logs}. The container is probably mid-restart; retry in a few seconds.`));
        }
        return ok(logs || "(no log output)");
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_events",
    {
      description: "Recent cluster events, newest last. Warnings only by default.",
      inputSchema: {
        namespace: z.string().optional().describe("Namespace; omit for all"),
        warningsOnly: z.boolean().optional().describe("Default true"),
      },
    },
    async ({ namespace, warningsOnly }) => {
      try {
        const fieldSelector = warningsOnly === false ? undefined : "type=Warning";
        const list = namespace
          ? await core.listNamespacedEvent({ namespace, fieldSelector })
          : await core.listEventForAllNamespaces({ fieldSelector });
        const items = list.items
          .sort((a, b) => new Date(a.lastTimestamp ?? 0).getTime() - new Date(b.lastTimestamp ?? 0).getTime())
          .slice(-40)
          .map(
            (e) =>
              `${age(e.lastTimestamp ?? undefined)} ago  ${e.type}  ${e.involvedObject.kind}/${e.involvedObject.namespace}/${e.involvedObject.name}  ${e.reason}: ${e.message}`,
          );
        return ok(items.length ? items.join("\n") : "No matching events.");
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "find_orphan_services",
    {
      description:
        "Find Services whose selector matches no ready pods (zero endpoints). Traffic to these goes nowhere, often because of a label typo.",
      inputSchema: { namespace: z.string().optional().describe("Namespace; omit for all") },
    },
    async ({ namespace }) => {
      try {
        const services = namespace
          ? await core.listNamespacedService({ namespace })
          : await core.listServiceForAllNamespaces();
        const slices = namespace
          ? await discovery.listNamespacedEndpointSlice({ namespace })
          : await discovery.listEndpointSliceForAllNamespaces();

        // Count ready endpoints per "namespace/service".
        const ready = new Map<string, number>();
        for (const s of slices.items) {
          const key = `${s.metadata?.namespace}/${s.metadata?.labels?.["kubernetes.io/service-name"]}`;
          const n = (s.endpoints ?? []).filter((e) => e.conditions?.ready !== false).length;
          ready.set(key, (ready.get(key) ?? 0) + n);
        }

        const orphans = services.items
          .filter((svc) => svc.spec?.selector && Object.keys(svc.spec.selector).length > 0) // skip selector-less services
          .filter((svc) => (ready.get(`${svc.metadata?.namespace}/${svc.metadata?.name}`) ?? 0) === 0)
          .map((svc) => ({
            service: `${svc.metadata?.namespace}/${svc.metadata?.name}`,
            selector: svc.spec?.selector,
            hint: "No ready pod has these labels. Check for a typo, or whether the matching pods are failing readiness.",
          }));
        return ok(orphans.length ? JSON.stringify(orphans, null, 2) : "Every Service has at least one ready endpoint.");
      } catch (err) {
        return fail(err);
      }
    },
  );
}