import z from "zod"
import { Tool } from "./tool"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import path from "path"
import { BunProc } from "@/bun"

import DESCRIPTION from "./qmd.txt"

export const QmdTool = Tool.define("qmd", {
    description: DESCRIPTION,
    parameters: z.object({
        query: z.string().describe("The search query or question to ask about the codebase"),
        mode: z.enum(["search", "read"]).optional().describe("Mode: 'search' for finding code/concepts, 'read' for reading a specific file path contextually. Defaults to 'search'."),
        limit: z.number().optional().describe("Max results (default: 10)"),
    }),
    async execute(params, ctx) {
        const config = await Config.get()

        // Check if QMD is enabled and configured in opencode.json (via MCP config)
        const mcpConfig = config.mcp?.qmd
        if (!mcpConfig || !mcpConfig.enabled) {
            return "QMD is not enabled or configured in opencode.json. Please ensure the QMD plugin or MCP server is set up."
        }

        // Determine command to run
        // mcp.qmd.command is array: ["bun", "/path/to/mcp.ts"]
        // We need to run the CLI, which is typically in the same directory but named `cli.ts`
        // OR we can try running `qmd` if it's in PATH, but safer to derive from config.

        let cmdArgs: string[] = []

        if ('type' in mcpConfig && mcpConfig.type === 'local' && Array.isArray(mcpConfig.command) && mcpConfig.command.length > 0) {
            const baseCmd = mcpConfig.command
            // Assume the command points to mcp.ts or similar entry point
            // If it's a file path ending in .ts or .js, we try to find cli.ts/cli.js in the same dir
            const entryPoint = baseCmd[baseCmd.length - 1]

            if (entryPoint.endsWith("mcp.ts")) {
                // Swap mcp.ts with cli.ts
                cmdArgs = [...baseCmd.slice(0, -1), entryPoint.replace("mcp.ts", "cli.ts")]
            } else if (entryPoint.endsWith("mcp.js")) {
                cmdArgs = [...baseCmd.slice(0, -1), entryPoint.replace("mcp.js", "cli.js")]
            } else {
                // Fallback: just append "cli" logic if we can't guess, or fail?
                // Let's assume the user configured it correctly or we can't run CLI from MCP config.
                // Actually, for now, let's trust the user or the plugin bootstrap to have set it up.
                // If we can't derive CLI, we might be stuck. 
                // Strategy: Use the directory of the MCP script and look for cli.ts
                try {
                    const dir = path.dirname(entryPoint)
                    const cliPathTs = path.join(dir, "cli.ts")
                    cmdArgs = ["bun", cliPathTs]
                } catch {
                    return "Could not determine QMD CLI path from MCP config."
                }
            }
        } else {
            return "Invalid QMD configuration."
        }

        // Construct CLI arguments
        const limit = params.limit || 10
        const qmdArgs = [...cmdArgs.slice(1)] // Remove 'bun' if it's the first arg, BunProc handles command?
        // BunProc.run takes [cmd, args...]
        // If cmdArgs is ["bun", "path/to/cli.ts"], we run "bun" with args ["path/to/cli.ts", ...]

        const toolArgs = []

        if (params.mode === "read") {
            // openralph_read_doc equivalent
            // cmd: multi-get <file> --json
            toolArgs.push("multi-get", params.query, "--json")

            await ctx.ask({
                permission: "qmd",
                patterns: [params.query],
                always: ["*"], // Read permission?
                metadata: { mode: "read", file: params.query },
            })
        } else {
            // openralph_search equivalent
            // cmd: query <query> --json -n <limit>
            toolArgs.push("query", params.query, "--json", "-n", limit.toString())

            await ctx.ask({
                permission: "qmd",
                patterns: [params.query],
                always: ["*"],
                metadata: { mode: "search", query: params.query },
            })
        }

        const commandStr = [cmdArgs[0], ...cmdArgs.slice(1), ...toolArgs].join(" ")
        console.error(`[QMD-DIAG] Executing: ${commandStr}`)

        try {
            // Run the command
            const proc = Bun.spawn([cmdArgs[0], ...cmdArgs.slice(1), ...toolArgs], {
                cwd: Instance.directory, // Run in project root
                stdout: "pipe",
                stderr: "pipe",
            })

            const output = await new Response(proc.stdout).text()
            const errorOutput = await new Response(proc.stderr).text()
            const exitCode = await proc.exited

            if (exitCode !== 0) {
                console.error(`[QMD-DIAG] Failed (exit ${exitCode}): ${errorOutput}`)
                if (exitCode === 1 && errorOutput.includes("not found")) { // Simple check
                    return "No results found."
                }
                return `QMD CLI failed (exit ${exitCode}): ${errorOutput || output}`
            }

            console.error(`[QMD-DIAG] Success. Output length: ${output.length}`)

            // Parse JSON output
            try {
                const json = JSON.parse(output)

                if (params.mode === "read") {
                    // Expect array of docs
                    if (!Array.isArray(json) || json.length === 0) return "Document not found."
                    return json[0].body || "(empty)"
                } else {
                    // Expect search results
                    if (!Array.isArray(json) || json.length === 0) return "No results found."
                    return json.map((r: any) =>
                        `[${Math.round((r.score || 0) * 100)}%] ${r.file}\n${r.title}\n${r.body || "..."}\n`
                    ).join("\n---\n")
                }
            } catch (e) {
                console.error(`[QMD-DIAG] JSON Parse Error: ${e}`)
                return `Failed to parse QMD output: ${e}. Raw: ${output.slice(0, 200)}`
            }

        } catch (e) {
            console.error(`[QMD-DIAG] Execution Error: ${e}`)
            return `Failed to execute QMD: ${e}`
        }
    }
})
