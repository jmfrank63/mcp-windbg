#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { CDBSession } from './cdbSession.js';
import { existsSync, statSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';

/**
 * Windows registry helper for getting dump paths
 */
async function getLocalDumpsPath(): Promise<string | null> {
  try {
    // On Windows, try to read the registry
    if (process.platform === 'win32') {
      const { execFile } = await import('child_process');
      const execFilePromise = promisify(execFile);
      
      try {
        const { stdout } = await execFilePromise('reg', [
          'query',
          'HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps',
          '/v',
          'DumpFolder'
        ]);
        
        const match = stdout.match(/DumpFolder\s+REG_[^\s]+\s+(.+)/i);
        if (match && match[1]) {
          const dumpFolder = match[1].trim();
          if (existsSync(dumpFolder) && statSync(dumpFolder).isDirectory()) {
            return dumpFolder;
          }
        }
      } catch {
        // Registry key doesn't exist
      }
    }

    // Try default Windows dump location
    const defaultPath = join(process.env.LOCALAPPDATA || '', 'CrashDumps');
    if (existsSync(defaultPath) && statSync(defaultPath).isDirectory()) {
      return defaultPath;
    }
  } catch (error) {
    // Ignore errors
  }

  return null;
}

/**
 * Find dump files in a directory
 */
function findDumpFiles(directory: string, recursive: boolean = false): string[] {
  const results: string[] = [];
  
  function searchDir(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory() && recursive) {
          searchDir(fullPath);
        } else if (entry.isFile() && entry.name.match(/\.(dmp|mdmp)$/i)) {
          results.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore permission errors etc.
    }
  }
  
  searchDir(directory);
  return results.sort();
}

/**
 * Find TTD trace files in a directory
 */
function findTTDTraces(directory: string, recursive: boolean = false): string[] {
  const results: string[] = [];
  
  function searchDir(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory() && recursive) {
          searchDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.run')) {
          results.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }
  
  searchDir(directory);
  return results.sort();
}

/**
 * Format file size in MB
 */
function formatFileSize(filePath: string): string {
  try {
    const stats = statSync(filePath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    return `${sizeMB} MB`;
  } catch {
    return 'unknown';
  }
}

/**
 * Active CDB sessions
 */
const activeSessions = new Map<string, CDBSession>();

/**
 * Get or create a CDB session
 */
async function getOrCreateSession(
  dumpPath?: string,
  connectionString?: string,
  options: {
    cdbPath?: string;
    symbolsPath?: string;
    timeout?: number;
    verbose?: boolean;
  } = {}
): Promise<CDBSession> {
  if (!dumpPath && !connectionString) {
    throw new Error('Either dumpPath or connectionString must be provided');
  }
  if (dumpPath && connectionString) {
    throw new Error('dumpPath and connectionString are mutually exclusive');
  }

  // Create session identifier
  const sessionId = dumpPath ? resolve(dumpPath) : `remote:${connectionString}`;

  if (!activeSessions.has(sessionId)) {
    try {
      const session = new CDBSession({
        dumpPath,
        remoteConnection: connectionString,
        cdbPath: options.cdbPath,
        symbolsPath: options.symbolsPath,
        timeout: (options.timeout ?? 30) * 1000, // Convert to milliseconds
        verbose: options.verbose ?? false,
      });

      await session.initialize();
      activeSessions.set(sessionId, session);
      return session;
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create CDB session: ${error}`
      );
    }
  }

  return activeSessions.get(sessionId)!;
}

/**
 * Unload a CDB session
 */
async function unloadSession(
  dumpPath?: string,
  connectionString?: string
): Promise<boolean> {
  if (!dumpPath && !connectionString) {
    return false;
  }
  if (dumpPath && connectionString) {
    return false;
  }

  const sessionId = dumpPath ? resolve(dumpPath) : `remote:${connectionString}`;

  if (activeSessions.has(sessionId)) {
    try {
      const session = activeSessions.get(sessionId)!;
      await session.shutdown();
      activeSessions.delete(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Main server implementation
 */
async function main() {
  const server = new Server(
    {
      name: 'mcp-windbg',
      version: '0.11.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'open_windbg_dump',
          description: `
Analyze a Windows crash dump file using WinDbg/CDB.
This tool executes common WinDbg commands to analyze the crash dump and returns the results.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              dump_path: {
                type: 'string',
                description: 'Path to the Windows crash dump file',
              },
              include_stack_trace: {
                type: 'boolean',
                description: 'Whether to include stack traces in the analysis',
              },
              include_modules: {
                type: 'boolean',
                description: 'Whether to include loaded module information',
              },
              include_threads: {
                type: 'boolean',
                description: 'Whether to include thread information',
              },
            },
            required: ['dump_path', 'include_stack_trace', 'include_modules', 'include_threads'],
          },
        },
        {
          name: 'open_windbg_remote',
          description: `
Connect to a remote debugging session using WinDbg/CDB.
This tool establishes a remote debugging connection and allows you to analyze the target process.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              connection_string: {
                type: 'string',
                description: "Remote connection string (e.g., 'tcp:Port=5005,Server=192.168.0.100')",
              },
              include_stack_trace: {
                type: 'boolean',
                description: 'Whether to include stack traces in the analysis',
                default: false,
              },
              include_modules: {
                type: 'boolean',
                description: 'Whether to include loaded module information',
                default: false,
              },
              include_threads: {
                type: 'boolean',
                description: 'Whether to include thread information',
                default: false,
              },
            },
            required: ['connection_string'],
          },
        },
        {
          name: 'run_windbg_cmd',
          description: `
Execute a specific WinDbg command on a loaded crash dump or remote session.
This tool allows you to run any WinDbg command and get the output.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              dump_path: {
                type: 'string',
                description: 'Path to the Windows crash dump file',
              },
              connection_string: {
                type: 'string',
                description: "Remote connection string (e.g., 'tcp:Port=5005,Server=192.168.0.100')",
              },
              command: {
                type: 'string',
                description: 'WinDbg command to execute',
              },
              timeout_seconds: {
                type: 'number',
                description: 'Timeout in seconds for the command (default: 30)',
                default: 30,
              },
            },
            required: ['command'],
          },
        },
        {
          name: 'close_windbg_dump',
          description: `
Unload a crash dump and release resources.
Use this tool when you're done analyzing a crash dump to free up resources.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              dump_path: {
                type: 'string',
                description: 'Path to the Windows crash dump file to unload',
              },
            },
            required: ['dump_path'],
          },
        },
        {
          name: 'close_windbg_remote',
          description: `
Close a remote debugging connection and release resources.
Use this tool when you're done with a remote debugging session to free up resources.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              connection_string: {
                type: 'string',
                description: 'Remote connection string to close',
              },
            },
            required: ['connection_string'],
          },
        },
        {
          name: 'list_windbg_dumps',
          description: `
List Windows crash dump files in the specified directory.
This tool helps you discover available crash dumps that can be analyzed.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              directory_path: {
                type: 'string',
                description:
                  'Directory path to search for dump files. If not specified, will use the configured dump path from registry.',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively in subdirectories',
                default: false,
              },
            },
          },
        },
        {
          name: 'record_ttd_trace',
          description: `
Record a Time Travel Debugging (TTD) trace by launching a new process.
Creates a .run trace file that can be replayed for analysis.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              executable_path: {
                type: 'string',
                description: 'Path to the executable to record',
              },
              arguments: {
                type: 'string',
                description: 'Command-line arguments for the executable',
              },
              output_directory: {
                type: 'string',
                description: 'Output directory for trace files',
              },
              ring_buffer: {
                type: 'boolean',
                description: 'Use ring buffer mode',
                default: false,
              },
              max_file_size: {
                type: 'number',
                description: 'Maximum trace file size in MB (ring buffer mode)',
              },
              include_children: {
                type: 'boolean',
                description: 'Record child processes',
                default: false,
              },
            },
            required: ['executable_path'],
          },
        },
        {
          name: 'attach_ttd_trace',
          description: `
Attach TTD to a running process and record a trace.
Useful for capturing traces of already-running applications.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              process_id: {
                type: 'number',
                description: 'Process ID to attach to',
              },
              output_directory: {
                type: 'string',
                description: 'Output directory for trace files',
              },
              ring_buffer: {
                type: 'boolean',
                description: 'Use ring buffer mode',
                default: false,
              },
              max_file_size: {
                type: 'number',
                description: 'Maximum trace file size in MB (ring buffer mode)',
              },
              include_children: {
                type: 'boolean',
                description: 'Record child processes',
                default: false,
              },
            },
            required: ['process_id'],
          },
        },
        {
          name: 'open_ttd_trace',
          description: `
Open and analyze a TTD trace file (.run).
Provides time travel debugging capabilities for recorded execution.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              trace_path: {
                type: 'string',
                description: 'Path to the TTD trace file (.run)',
              },
              include_position_info: {
                type: 'boolean',
                description: 'Include current position information',
                default: true,
              },
              include_threads: {
                type: 'boolean',
                description: 'Include thread information',
                default: false,
              },
              include_modules: {
                type: 'boolean',
                description: 'Include module information',
                default: false,
              },
            },
            required: ['trace_path'],
          },
        },
        {
          name: 'close_ttd_trace',
          description: `
Close a TTD trace and release resources.
Use this when done analyzing a trace file.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              trace_path: {
                type: 'string',
                description: 'Path to the TTD trace file to close',
              },
            },
            required: ['trace_path'],
          },
        },
        {
          name: 'list_ttd_traces',
          description: `
List TTD trace files (.run) in a directory.
Helps discover available traces for analysis.
          `,
          inputSchema: {
            type: 'object',
            properties: {
              directory_path: {
                type: 'string',
                description: 'Directory to search for .run files',
              },
              recursive: {
                type: 'boolean',
                description: 'Search recursively in subdirectories',
                default: false,
              },
            },
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Tool: open_windbg_dump
      if (name === 'open_windbg_dump') {
        const { dump_path, include_stack_trace, include_modules, include_threads } = args as {
          dump_path?: string;
          include_stack_trace: boolean;
          include_modules: boolean;
          include_threads: boolean;
        };

        // Check if dump_path is missing or empty
        if (!dump_path) {
          const localDumpsPath = await getLocalDumpsPath();
          let dumpsFoundText = '';

          if (localDumpsPath) {
            const dumpFiles = findDumpFiles(localDumpsPath, false);

            if (dumpFiles.length > 0) {
              dumpsFoundText = `\n\nI found ${dumpFiles.length} crash dump(s) in ${localDumpsPath}:\n\n`;
              for (let i = 0; i < Math.min(10, dumpFiles.length); i++) {
                const size = formatFileSize(dumpFiles[i]);
                dumpsFoundText += `${i + 1}. ${dumpFiles[i]} (${size})\n`;
              }

              if (dumpFiles.length > 10) {
                dumpsFoundText += `\n... and ${dumpFiles.length - 10} more dump files.\n`;
              }

              dumpsFoundText += '\nYou can analyze one of these dumps by specifying its path.';
            }
          }

          return {
            content: [
              {
                type: 'text',
                text:
                  `Please provide a path to a crash dump file to analyze.${dumpsFoundText}\n\n` +
                  `You can use the 'list_windbg_dumps' tool to discover available crash dumps.`,
              },
            ],
          };
        }

        const session = await getOrCreateSession(dump_path);
        const results: string[] = [];

        // Get crash information
        const crashInfo = await session.sendCommand('.lastevent');
        results.push('### Crash Information\n```\n' + crashInfo.join('\n') + '\n```\n\n');

        // Run !analyze -v
        const analysis = await session.sendCommand('!analyze -v');
        results.push('### Crash Analysis\n```\n' + analysis.join('\n') + '\n```\n\n');

        // Optional sections
        if (include_stack_trace) {
          const stack = await session.sendCommand('kb');
          results.push('### Stack Trace\n```\n' + stack.join('\n') + '\n```\n\n');
        }

        if (include_modules) {
          const modules = await session.sendCommand('lm');
          results.push('### Loaded Modules\n```\n' + modules.join('\n') + '\n```\n\n');
        }

        if (include_threads) {
          const threads = await session.sendCommand('~');
          results.push('### Threads\n```\n' + threads.join('\n') + '\n```\n\n');
        }

        return {
          content: [{ type: 'text', text: results.join('') }],
        };
      }

      // Tool: open_windbg_remote
      if (name === 'open_windbg_remote') {
        const { connection_string, include_stack_trace, include_modules, include_threads } = args as {
          connection_string: string;
          include_stack_trace?: boolean;
          include_modules?: boolean;
          include_threads?: boolean;
        };

        const session = await getOrCreateSession(undefined, connection_string);
        const results: string[] = [];

        // Get target information
        const targetInfo = await session.sendCommand('!peb');
        results.push('### Target Process Information\n```\n' + targetInfo.join('\n') + '\n```\n\n');

        // Get current state
        const currentState = await session.sendCommand('r');
        results.push('### Current Registers\n```\n' + currentState.join('\n') + '\n```\n\n');

        // Optional sections
        if (include_stack_trace) {
          const stack = await session.sendCommand('kb');
          results.push('### Stack Trace\n```\n' + stack.join('\n') + '\n```\n\n');
        }

        if (include_modules) {
          const modules = await session.sendCommand('lm');
          results.push('### Loaded Modules\n```\n' + modules.join('\n') + '\n```\n\n');
        }

        if (include_threads) {
          const threads = await session.sendCommand('~');
          results.push('### Threads\n```\n' + threads.join('\n') + '\n```\n\n');
        }

        return {
          content: [{ type: 'text', text: results.join('') }],
        };
      }

      // Tool: run_windbg_cmd
      if (name === 'run_windbg_cmd') {
        const { dump_path, connection_string, command, timeout_seconds } = args as {
          dump_path?: string;
          connection_string?: string;
          command: string;
          timeout_seconds?: number;
        };

        const session = await getOrCreateSession(dump_path, connection_string);
        const timeoutMs = (timeout_seconds ?? 30) * 1000;
        const output = await session.sendCommand(command, timeoutMs);

        return {
          content: [
            {
              type: 'text',
              text: `Command: ${command}\n\nOutput:\n\`\`\`\n${output.join('\n')}\n\`\`\``,
            },
          ],
        };
      }

      // Tool: close_windbg_dump
      if (name === 'close_windbg_dump') {
        const { dump_path } = args as { dump_path: string };
        const success = await unloadSession(dump_path);

        return {
          content: [
            {
              type: 'text',
              text: success
                ? `Successfully unloaded crash dump: ${dump_path}`
                : `No active session found for crash dump: ${dump_path}`,
            },
          ],
        };
      }

      // Tool: close_windbg_remote
      if (name === 'close_windbg_remote') {
        const { connection_string } = args as { connection_string: string };
        const success = await unloadSession(undefined, connection_string);

        return {
          content: [
            {
              type: 'text',
              text: success
                ? `Successfully closed remote connection: ${connection_string}`
                : `No active session found for remote connection: ${connection_string}`,
            },
          ],
        };
      }

      // Tool: list_windbg_dumps
      if (name === 'list_windbg_dumps') {
        let { directory_path, recursive } = args as {
          directory_path?: string;
          recursive?: boolean;
        };

        if (!directory_path) {
          directory_path = await getLocalDumpsPath() ?? undefined;
          if (!directory_path) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'No directory path specified and no default dump path found in registry.'
            );
          }
        }

        if (!existsSync(directory_path) || !statSync(directory_path).isDirectory()) {
          throw new McpError(ErrorCode.InvalidParams, `Directory not found: ${directory_path}`);
        }

        const dumpFiles = findDumpFiles(directory_path, recursive ?? false);

        if (dumpFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No crash dump files (*.*dmp) found in ${directory_path}`,
              },
            ],
          };
        }

        let resultText = `Found ${dumpFiles.length} crash dump file(s) in ${directory_path}:\n\n`;
        for (let i = 0; i < dumpFiles.length; i++) {
          const size = formatFileSize(dumpFiles[i]);
          resultText += `${i + 1}. ${dumpFiles[i]} (${size})\n`;
        }

        return {
          content: [{ type: 'text', text: resultText }],
        };
      }

      // Tool: record_ttd_trace
      if (name === 'record_ttd_trace') {
        const {
          executable_path,
          arguments: exeArgs,
          output_directory,
          ring_buffer,
          max_file_size,
          include_children,
        } = args as {
          executable_path: string;
          arguments?: string;
          output_directory?: string;
          ring_buffer?: boolean;
          max_file_size?: number;
          include_children?: boolean;
        };

        // Build TTD command
        const cmd = ['ttd.exe', '-accepteula'];

        if (output_directory) {
          cmd.push('-out', output_directory);
        }

        if (ring_buffer) {
          cmd.push('-ring');
          if (max_file_size) {
            cmd.push('-maxFile', max_file_size.toString());
          }
        }

        if (include_children) {
          cmd.push('-children');
        }

        cmd.push(executable_path);
        if (exeArgs) {
          cmd.push(...exeArgs.split(' '));
        }

        try {
          const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const proc = spawn(cmd[0], cmd.slice(1), {
              timeout: 300000, // 5 minutes
            });

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data) => (stdout += data.toString()));
            proc.stderr?.on('data', (data) => (stderr += data.toString()));

            proc.on('close', (code) => {
              if (code === 0) {
                resolve({ stdout, stderr });
              } else {
                reject(new Error(`TTD process exited with code ${code}`));
              }
            });

            proc.on('error', reject);
          });

          const output = result.stdout + result.stderr;

          // Try to find trace path in output
          let tracePath = null;
          for (const line of output.split('\n')) {
            if (line.includes('.run')) {
              tracePath = line.trim();
              break;
            }
          }

          let resultText = `TTD recording completed.\n\nCommand: ${cmd.join(' ')}\n\nOutput:\n${output}`;
          if (tracePath) {
            resultText += `\n\nTrace file: ${tracePath}`;
          }

          return {
            content: [{ type: 'text', text: resultText }],
          };
        } catch (error) {
          if ((error as any).code === 'ENOENT') {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'TTD.exe not found. Please ensure Time Travel Debugging is installed.\nDownload from: https://aka.ms/ttd/download',
                },
              ],
            };
          }
          throw error;
        }
      }

      // Tool: attach_ttd_trace
      if (name === 'attach_ttd_trace') {
        const { process_id, output_directory, ring_buffer, max_file_size, include_children } = args as {
          process_id: number;
          output_directory?: string;
          ring_buffer?: boolean;
          max_file_size?: number;
          include_children?: boolean;
        };

        // Build TTD command
        const cmd = ['ttd.exe', '-accepteula', '-attach', process_id.toString()];

        if (output_directory) {
          cmd.push('-out', output_directory);
        }

        if (ring_buffer) {
          cmd.push('-ring');
          if (max_file_size) {
            cmd.push('-maxFile', max_file_size.toString());
          }
        }

        if (include_children) {
          cmd.push('-children');
        }

        try {
          const proc = spawn(cmd[0], cmd.slice(1));

          // Give it time to attach
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Keep process reference to prevent garbage collection
          void proc;

          return {
            content: [
              {
                type: 'text',
                text:
                  `TTD successfully attached to process ${process_id}.\n\n` +
                  `Recording in progress. Stop the target process to complete the trace.\n\n` +
                  `Command: ${cmd.join(' ')}`,
              },
            ],
          };
        } catch (error) {
          if ((error as any).code === 'ENOENT') {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'TTD.exe not found. Please ensure Time Travel Debugging is installed.\nDownload from: https://aka.ms/ttd/download',
                },
              ],
            };
          }
          throw error;
        }
      }

      // Tool: open_ttd_trace
      if (name === 'open_ttd_trace') {
        const { trace_path, include_position_info, include_threads, include_modules } = args as {
          trace_path: string;
          include_position_info?: boolean;
          include_threads?: boolean;
          include_modules?: boolean;
        };

        if (!existsSync(trace_path)) {
          throw new McpError(ErrorCode.InvalidParams, `TTD trace file not found: ${trace_path}`);
        }

        const session = await getOrCreateSession(trace_path);
        const results: string[] = [];

        results.push('### TTD Trace Information\n');

        if (include_position_info !== false) {
          const position = await session.sendCommand('!tt');
          results.push('#### Current Position\n```\n' + position.join('\n') + '\n```\n\n');

          const positionRange = await session.sendCommand('!tt 0');
          results.push('#### Position Range\n```\n' + positionRange.join('\n') + '\n```\n\n');
        }

        // Get exceptions
        const exceptions = await session.sendCommand(
          'dx @$cursession.TTD.Events.Where(t => t.Type == "Exception")'
        );
        results.push('#### Exceptions in Trace\n```\n' + exceptions.join('\n') + '\n```\n\n');

        if (include_threads) {
          const threads = await session.sendCommand('~');
          results.push('#### Threads\n```\n' + threads.join('\n') + '\n```\n\n');
        }

        if (include_modules) {
          const modules = await session.sendCommand('lm');
          results.push('#### Loaded Modules\n```\n' + modules.join('\n') + '\n```\n\n');
        }

        return {
          content: [{ type: 'text', text: results.join('') }],
        };
      }

      // Tool: close_ttd_trace
      if (name === 'close_ttd_trace') {
        const { trace_path } = args as { trace_path: string };
        const success = await unloadSession(trace_path);

        return {
          content: [
            {
              type: 'text',
              text: success
                ? `Successfully closed TTD trace: ${trace_path}`
                : `No active session found for TTD trace: ${trace_path}`,
            },
          ],
        };
      }

      // Tool: list_ttd_traces
      if (name === 'list_ttd_traces') {
        let { directory_path, recursive } = args as {
          directory_path?: string;
          recursive?: boolean;
        };

        if (!directory_path) {
          directory_path = process.cwd();
        }

        if (!existsSync(directory_path) || !statSync(directory_path).isDirectory()) {
          throw new McpError(ErrorCode.InvalidParams, `Directory not found: ${directory_path}`);
        }

        const traceFiles = findTTDTraces(directory_path, recursive ?? false);

        if (traceFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No TTD trace files (*.run) found in ${directory_path}`,
              },
            ],
          };
        }

        let resultText = `Found ${traceFiles.length} TTD trace file(s) in ${directory_path}:\n\n`;
        for (let i = 0; i < traceFiles.length; i++) {
          const size = formatFileSize(traceFiles[i]);
          resultText += `${i + 1}. ${traceFiles[i]} (${size})\n`;
        }

        return {
          content: [{ type: 'text', text: resultText }],
        };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('mcp-windbg MCP server running on stdio');
}

// Cleanup on exit
process.on('SIGINT', async () => {
  console.error('Shutting down...');
  for (const [, session] of activeSessions) {
    await session.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  for (const [, session] of activeSessions) {
    await session.shutdown();
  }
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
