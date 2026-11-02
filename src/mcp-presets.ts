/**
 * Built-in MCP integrations surfaced by `boom mcp presets` and the desktop MCP dialog.
 *
 * A preset is a reviewed starting point, not an auto-enabled server: adding one still writes the
 * Boom-managed MCP store and restarts the runtime through the normal path.
 */
import type { ManagedMcpServer } from "./mcp-config.ts"
import { reaMcpServer, REA_SERVER_ID } from "./rea.ts"

export type McpPreset = {
  id: string
  name: string
  description: string
  server: ManagedMcpServer
}

export function mcpPresets(): McpPreset[] {
  return [
    {
      id: REA_SERVER_ID,
      name: "REA",
      description:
        "逆向工程 MCP：原生二进制、Electron/JavaScript、.NET、Android、固件与浏览器目标。" +
        "Boom 通过 rea_tools / rea_call 按需访问全部 REA 能力，避免工具 schema 占用上下文。",
      server: reaMcpServer(),
    },
  ]
}
