#!/usr/bin/env node
// Entry point: create the MCP server, register tools and a prompt, talk over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerClusterTools } from "./tools/cluster.js";
import { registerArgoTools } from "./tools/argocd.js";
import { registerTriageTool } from "./tools/triage.js";
import { ALLOW_WRITES, currentContext } from "./k8s.js";

const server = new McpServer({ name: "kubeaid-mcp", version: "0.1.0" });

registerClusterTools(server);
registerArgoTools(server);
registerTriageTool(server);

// A prompt = a reusable instruction the user can pick in their AI client.
// This one encodes KubeAid habits.
server.registerPrompt(
  "triage",
  { description: "Diagnose the cluster the KubeAid way" },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Run triage_cluster. For each critical finding, drill in with describe_pod and pod_logs (previous=true for crashes) and state the root cause in one sentence. " +
            "For ArgoCD apps that are OutOfSync, run argocd_app_drift and explain the drift. " +
            "KubeAid rules: Git (the kubeaid-config repo) is the source of truth, so propose fixes as changes to files in kubeaid-config, not kubectl edits; " +
            "never sync without showing the drift and getting my OK first.",
        },
      },
    ],
  }),
);

// stdout is reserved for the MCP protocol, so all logging goes to stderr.
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`kubeaid-mcp running on stdio. context=${currentContext()} writes=${ALLOW_WRITES ? "on" : "off"}`);