import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { EventEmitter } from 'events';

/**
 * Regular expression to detect command completion marker
 */
const COMMAND_MARKER = '.echo COMMAND_COMPLETED_MARKER';
const COMMAND_MARKER_PATTERN = /COMMAND_COMPLETED_MARKER/;

/**
 * Default paths where cdb.exe might be located
 */
const DEFAULT_CDB_PATHS = [
  // Microsoft Store WinDbg Preview locations (check first)
  `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\cdbX64.exe`,
  `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\cdbX86.exe`,
  `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\cdbARM64.exe`,
  `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\cdb.exe`,
  
  // Traditional Windows SDK locations
  'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe',
  'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\cdb.exe',
  'C:\\Program Files\\Debugging Tools for Windows (x64)\\cdb.exe',
  'C:\\Program Files\\Debugging Tools for Windows (x86)\\cdb.exe',
];

/**
 * Custom error for CDB-related issues
 */
export class CDBError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CDBError';
  }
}

/**
 * Options for creating a CDB session
 */
export interface CDBSessionOptions {
  dumpPath?: string;
  remoteConnection?: string;
  cdbPath?: string;
  symbolsPath?: string;
  initialCommands?: string[];
  timeout?: number;
  verbose?: boolean;
  additionalArgs?: string[];
}

/**
 * CDB Session Manager
 * Manages a CDB debugging session for crash dumps or remote debugging
 */
export class CDBSession extends EventEmitter {
  private process: ChildProcess | null = null;
  private dumpPath?: string;
  private remoteConnection?: string;
  private cdbPath: string;
  private timeout: number;
  private verbose: boolean;
  
  private outputLines: string[] = [];
  private outputBuffer: string = '';
  private readyCallbacks: Array<() => void> = [];

  constructor(options: CDBSessionOptions) {
    super();
    
    // Validate that exactly one of dumpPath or remoteConnection is provided
    if (!options.dumpPath && !options.remoteConnection) {
      throw new Error('Either dumpPath or remoteConnection must be provided');
    }
    if (options.dumpPath && options.remoteConnection) {
      throw new Error('dumpPath and remoteConnection are mutually exclusive');
    }

    // Validate dump file exists if provided
    if (options.dumpPath && !existsSync(options.dumpPath)) {
      throw new Error(`Dump file not found: ${options.dumpPath}`);
    }

    this.dumpPath = options.dumpPath;
    this.remoteConnection = options.remoteConnection;
    this.timeout = options.timeout ?? 30000; // 30 seconds default
    this.verbose = options.verbose ?? false;

    // Find CDB executable
    this.cdbPath = this.findCdbExecutable(options.cdbPath);
    if (!this.cdbPath) {
      throw new CDBError('Could not find cdb.exe. Please provide a valid path.');
    }

    // Build command args
    const cmdArgs: string[] = [];

    // Add connection type specific arguments
    if (this.dumpPath) {
      cmdArgs.push('-z', this.dumpPath);
    } else if (this.remoteConnection) {
      cmdArgs.push('-remote', this.remoteConnection);
    }

    // Add symbols path if provided
    if (options.symbolsPath) {
      cmdArgs.push('-y', options.symbolsPath);
    }

    // Add any additional arguments
    if (options.additionalArgs) {
      cmdArgs.push(...options.additionalArgs);
    }

    // Start CDB process
    try {
      this.process = spawn(this.cdbPath, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });

      // Set up output handling
      if (this.process.stdout) {
        this.process.stdout.on('data', (data: Buffer) => {
          this.handleOutput(data.toString());
        });
      }

      if (this.process.stderr) {
        this.process.stderr.on('data', (data: Buffer) => {
          if (this.verbose) {
            console.error('CDB stderr:', data.toString());
          }
        });
      }

      this.process.on('error', (error) => {
        this.emit('error', new CDBError(`CDB process error: ${error.message}`));
      });

      this.process.on('exit', (code) => {
        if (this.verbose) {
          console.log(`CDB process exited with code ${code}`);
        }
        this.process = null;
      });

    } catch (error) {
      throw new CDBError(`Failed to start CDB process: ${error}`);
    }
  }

  /**
   * Initialize the session and wait for CDB to be ready
   */
  async initialize(initialCommands?: string[]): Promise<void> {
    // Wait for initial prompt
    await this.waitForPrompt();

    // Run initial commands if provided
    if (initialCommands) {
      for (const cmd of initialCommands) {
        await this.sendCommand(cmd);
      }
    }
  }

  /**
   * Find the cdb.exe executable
   */
  private findCdbExecutable(customPath?: string): string {
    if (customPath && existsSync(customPath)) {
      return customPath;
    }

    // Check environment variable first
    if (process.env.CDB_PATH) {
      // Don't check existsSync for App Execution Aliases, just return the path
      return process.env.CDB_PATH;
    }

    // Try using 'where' command on Windows to find cdb executables in PATH
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        // Try multiple possible executable names
        for (const exeName of ['cdbX64.exe', 'cdb.exe', 'cdbX86.exe', 'cdbARM64.exe']) {
          try {
            const output = execSync(`where ${exeName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const paths = output.trim().split('\n');
            if (paths.length > 0 && paths[0]) {
              const foundPath = paths[0].trim();
              if (foundPath) {
                // Return the executable name directly since spawn can find it in PATH
                // This works even for App Execution Aliases
                return exeName;
              }
            }
          } catch {
            // Continue to next executable name
          }
        }
      } catch {
        // Fall through to check default paths
      }
    }

    for (const path of DEFAULT_CDB_PATHS) {
      if (existsSync(path)) {
        return path;
      }
    }

    throw new CDBError('Could not find cdb.exe');
  }

  /**
   * Handle output from CDB process
   */
  private handleOutput(data: string): void {
    this.outputBuffer += data;
    
    // Split on newlines and process complete lines
    const lines = this.outputBuffer.split(/\r?\n/);
    
    // Keep the last incomplete line in the buffer
    this.outputBuffer = lines.pop() || '';
    
    for (const line of lines) {
      const trimmedLine = line.trimEnd();
      
      if (this.verbose) {
        console.log(`CDB > ${trimmedLine}`);
      }

      this.outputLines.push(trimmedLine);

      // Check for command marker
      if (COMMAND_MARKER_PATTERN.test(trimmedLine)) {
        // Remove the marker line itself
        if (this.outputLines.length > 0 && 
            COMMAND_MARKER_PATTERN.test(this.outputLines[this.outputLines.length - 1])) {
          this.outputLines.pop();
        }
        
        // Notify all waiting callbacks
        const callbacks = this.readyCallbacks.splice(0);
        callbacks.forEach(cb => cb());
      }
    }
  }

  /**
   * Wait for CDB to be ready by sending a marker command
   */
  private async waitForPrompt(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new CDBError('Timed out waiting for CDB prompt'));
      }, this.timeout);

      this.readyCallbacks.push(() => {
        clearTimeout(timeoutId);
        resolve();
      });

      this.outputLines = [];
      
      if (this.process?.stdin) {
        this.process.stdin.write(`${COMMAND_MARKER}\n`);
      } else {
        clearTimeout(timeoutId);
        reject(new CDBError('CDB stdin is not available'));
      }
    });
  }

  /**
   * Send a command to CDB and wait for output
   */
  async sendCommand(command: string, customTimeout?: number): Promise<string[]> {
    if (!this.process || !this.process.stdin) {
      throw new CDBError('CDB process is not running');
    }

    return new Promise<string[]>((resolve, reject) => {
      const timeoutDuration = customTimeout ?? this.timeout;
      const timeoutId = setTimeout(() => {
        reject(new CDBError(`Command timed out after ${timeoutDuration}ms: ${command}`));
      }, timeoutDuration);

      this.readyCallbacks.push(() => {
        clearTimeout(timeoutId);
        const result = [...this.outputLines];
        this.outputLines = [];
        resolve(result);
      });

      this.outputLines = [];

      try {
        // Send the command followed by marker
        if (!this.process?.stdin) {
          throw new Error('CDB stdin not available');
        }
        this.process.stdin.write(`${command}\n${COMMAND_MARKER}\n`);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(new CDBError(`Failed to send command: ${error}`));
      }
    });
  }

  /**
   * Get a unique session identifier
   */
  getSessionId(): string {
    if (this.dumpPath) {
      return resolve(this.dumpPath);
    } else if (this.remoteConnection) {
      return `remote:${this.remoteConnection}`;
    }
    throw new CDBError('Session has no valid identifier');
  }

  /**
   * Shutdown the CDB session
   */
  async shutdown(): Promise<void> {
    if (this.process && this.process.stdin) {
      try {
        if (this.remoteConnection) {
          // For remote connections, send CTRL+B to detach
          this.process.stdin.write('\x02');
        } else {
          // For dump files, send 'q' to quit
          this.process.stdin.write('q\n');
        }
        
        // Wait a bit for graceful exit
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        if (this.verbose) {
          console.error('Error during shutdown:', error);
        }
      }

      // Force kill if still running
      if (this.process && !this.process.killed) {
        this.process.kill();
      }
    }
    
    this.process = null;
  }
}
