// Everything about connecting to Kubernetes lives here, plus the safety settings.
import * as k8s from "@kubernetes/client-node";

// Reads ~/.kube/config, the same file kubectl uses.
export const kc = new k8s.KubeConfig();
kc.loadFromDefault();

// Optional: pin one cluster. Otherwise follow kubectl's current context.
if (process.env.KUBEAID_MCP_CONTEXT) {
  kc.setCurrentContext(process.env.KUBEAID_MCP_CONTEXT);
}

// One client per API group, like `kubectl` uses different API paths.
export const core = kc.makeApiClient(k8s.CoreV1Api); // pods, services, events, nodes
export const discovery = kc.makeApiClient(k8s.DiscoveryV1Api); // endpointslices
export const custom = kc.makeApiClient(k8s.CustomObjectsApi); // CRDs like ArgoCD Applications

export const ARGOCD_NAMESPACE = process.env.KUBEAID_MCP_ARGOCD_NAMESPACE ?? "argocd";

// ---- Safety model ----
// Read-only unless writes are switched on explicitly.
export const ALLOW_WRITES = process.env.KUBEAID_MCP_ALLOW_WRITES === "true";
// Contexts listed here refuse every write, even with writes on.
const PROTECTED = (process.env.KUBEAID_MCP_PROTECTED_CONTEXTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function currentContext(): string {
  return kc.getCurrentContext();
}

// Throws if a write isn't allowed right now. Called at the start of every write tool.
export function assertWritable(): void {
  if (!ALLOW_WRITES) {
    throw new Error("Writes are disabled. Start the server with KUBEAID_MCP_ALLOW_WRITES=true to allow them.");
  }
  if (PROTECTED.includes(currentContext())) {
    throw new Error(`Context "${currentContext()}" is protected. Writes are refused here.`);
  }
}

// ---- Helpers that turn results into MCP tool responses ----
export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function fail(err: unknown) {
  // The k8s client puts the API server's reason in err.body; fall back to the message.
  const e = err as { body?: unknown; message?: string };
  const detail = typeof e.body === "string" ? e.body : e.message ?? String(err);
  return { content: [{ type: "text" as const, text: `Error: ${detail}` }], isError: true };
}

// "3m", "2h", "5d" — how long ago a timestamp was.
export function age(ts?: Date | string): string {
  if (!ts) return "?";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}